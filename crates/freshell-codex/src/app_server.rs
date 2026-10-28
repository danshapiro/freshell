//! codex **app-server client** — the JSON-RPC-2.0-over-WebSocket client CORE, a faithful
//! port of `server/coding-cli/codex-app-server/client.ts` with all IO injected behind the
//! [`WsTransport`] trait so it is unit-testable without a real `codex app-server`.
//!
//! Responsibilities (mirroring `client.ts`):
//! - **framing:** one JSON message per frame; requests are `{ id, method, params }` with an
//!   integer id (`nextRequestId++`), decoded via [`crate::protocol`].
//! - **readiness handshake:** `initialize` request → parse result → `notify('initialized')`;
//!   every non-`initialize` call awaits initialize first (`client.ts:144-165,777-778`).
//! - **request/response correlation:** a pending map keyed by request id; a background
//!   consumer resolves responses/errors and dispatches notifications (`client.ts:567-641`).
//! - **thread / turn drive:** [`CodexAppServerClient::start_thread`],
//!   [`CodexAppServerClient::start_turn`] (**forwarding `effort` VERBATIM** — DEV-0003),
//!   [`CodexAppServerClient::interrupt_turn`].
//! - **notification consumer:** classified [`CodexNotification`]s are streamed to the caller
//!   (the codex adapter's `onTurnCompleted`/`onThreadLifecycle` fan-out, `client.ts:472-519`).
//!
//! The real `tokio-tungstenite` [`WsTransport`] lives in [`crate::transport`] behind the
//! default-off `real-transport` feature; [`ChannelTransport`] is an in-memory loopback used
//! by the tests and the future scripted harness.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};

use crate::protocol::{
    build_notification_frame, build_request_frame, classify_notification, parse_client_frame,
    parse_incoming_frame, ClientFrame, CodexNotification, IncomingMessage, RequestId, RpcError,
};

/// The reference default request timeout (`DEFAULT_REQUEST_TIMEOUT_MS`, `client.ts:65`).
/// Applies to every RPC EXCEPT the snapshot-path reads below (`thread/read`, `thread/resume`).
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 5_000;

/// **DELIBERATE DEVIATION from legacy parity** \u2014 the budget for `thread/read` and
/// `thread/resume` only.
///
/// Legacy (`client.ts:65,141`) uses `DEFAULT_REQUEST_TIMEOUT_MS` (5s) UNIFORMLY for every
/// RPC, including `readThread` (`adapter.ts:1089,1094` \u2014 `getSnapshot`'s full-thread read).
/// There is no larger legacy budget to "adopt": grep of `runtime.ts`/`adapter.ts`/`server/index.ts`
/// confirms no caller ever passes a longer `requestTimeoutMs` for reads specifically.
///
/// Proven on real data: `GET /api/fresh-agent/threads/freshcodex/codex/<id>` for a real
/// ~4,000-raw-item session 500'd with "did not respond to thread/read within 5000ms" on the
/// first attempt; an immediate retry succeeded (the app-server's internal parse/cache of a
/// huge thread can itself take single-digit seconds, independent of cold-spawn). At 5s this
/// is a real, reproducible daily-use failure (the frozen SPA shows "Failed to load session").
///
/// A REST snapshot fetch is not latency-sensitive the way `turn/start`/`turn/interrupt` are
/// (those stay at `DEFAULT_REQUEST_TIMEOUT_MS`, unchanged \u2014 an interactive turn should fail
/// fast). But it also shouldn't hang forever, so this is capped rather than unbounded: 30s.
pub const SNAPSHOT_READ_TIMEOUT_MS: u64 = 30_000;

/// Unified agent names (Task 3): the per-request bound for the NATIVE-NAMES
/// metadata read (`thread/read` with `includeTurns:false`) — the plan's
/// 20-second native request budget. Deliberately NOT the 30s snapshot budget
/// above (that exists for full-thread reads whose parse can take seconds; a
/// metadata-only read has no such latency profile and must never pin the
/// serial native worker for 30s), and not the 5s interactive budget either —
/// the plan bounds every native request to 20s.
pub const NATIVE_METADATA_READ_TIMEOUT_MS: u64 = 20_000;

/// A boxed, `Send` future — the object-safe async return used by [`WsTransport`] (keeps it
/// `dyn`-compatible without an `async-trait` dependency; same pattern as `freshell-opencode`).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The injected WebSocket transport seam (the `ws` socket in `client.ts:1`). One text frame
/// per JSON message. `recv` resolves `None` on close; `send` errors surface as
/// [`CodexAppServerError::Transport`].
pub trait WsTransport: Send + Sync {
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>>;
    fn recv(&self) -> BoxFuture<'_, Option<String>>;
    fn close(&self) -> BoxFuture<'_, ()>;
}

/// Errors surfaced by the client (the reference throws `Error`/`CodexAppServerRpcError`).
#[derive(Clone, Debug, PartialEq)]
pub enum CodexAppServerError {
    /// A JSON-RPC error envelope for the request (`CodexAppServerRpcError`, `client.ts:68-78`).
    Rpc { method: String, error: RpcError },
    /// The request timed out (`client.ts:784-787`).
    Timeout { method: String, timeout_ms: u64 },
    /// The connection closed before the request completed (`client.ts:449,726`).
    Closed { method: String },
    /// The transport failed to send (`client.ts:797-800`).
    Transport { method: String, message: String },
    /// The server returned a payload the client could not parse (`client.ts:176-177`, etc.).
    InvalidResponse { method: String, detail: String },
}

impl std::fmt::Display for CodexAppServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexAppServerError::Rpc { method, error } => {
                write!(f, "Codex app-server {method} failed: {error}")
            }
            CodexAppServerError::Timeout { method, timeout_ms } => {
                write!(
                    f,
                    "Codex app-server did not respond to {method} within {timeout_ms}ms."
                )
            }
            CodexAppServerError::Closed { method } => {
                write!(
                    f,
                    "Codex app-server connection closed before {method} completed."
                )
            }
            CodexAppServerError::Transport { method, message } => {
                write!(
                    f,
                    "Codex app-server transport failed sending {method}: {message}"
                )
            }
            CodexAppServerError::InvalidResponse { method, detail } => {
                write!(
                    f,
                    "Codex app-server returned an invalid {method} payload: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for CodexAppServerError {}

impl CodexAppServerError {
    /// Evidence-backed pre-admission refusals in the supported native protocol.
    /// Internal errors, transport failures and lost replies can follow accepted
    /// work, so callers must preserve their delivery receipt as ambiguous.
    pub fn is_not_submitted(&self) -> bool {
        match self {
            Self::Rpc { method, error } => {
                method == "initialize"
                    || method == "configRequirements/read"
                    || matches!(error.code, -32601 | -32602)
                    || (error.code == -32600
                        && (error.message.starts_with("no active turn to ")
                            || error.message.starts_with("expected active turn id")))
            }
            Self::Timeout { method, .. }
            | Self::Closed { method }
            | Self::Transport { method, .. }
            | Self::InvalidResponse { method, .. } => {
                matches!(method.as_str(), "initialize" | "configRequirements/read")
            }
        }
    }
}

/// `thread/start` params (`CodexThreadStartInput`, `client.ts:80-83`; adapter create,
/// `adapter.ts:825-830`). The client adds `experimentalRawEvents:false` +
/// `persistExtendedHistory:true` (`client.ts:170-174`).
#[derive(Clone, Debug, Default)]
pub struct StartThreadParams {
    pub cwd: Option<String>,
    pub model: Option<String>,
    /// `read-only` | `workspace-write` | `danger-full-access` (`CodexSandboxModeSchema`).
    pub sandbox: Option<String>,
    /// `untrusted` | `on-failure` | `on-request` | `never` (`CodexAskForApprovalSchema`).
    pub approval_policy: Option<String>,
    /// Kata 1wxv Task 2 (LBC-1): every thread freshell STARTS adopts
    /// `historyMode:"paginated"` — `thread/revert` refuses legacy threads. Sent
    /// on `thread/start` ONLY: `thread/resume` takes NO mode param (the durable
    /// rollout meta carries the mode; see [`crate::durability::read_rollout_history_mode`]).
    pub history_mode: Option<crate::durability::HistoryMode>,
}

/// The `thread/start` / `thread/resume` result the adapter reads (`client.ts:181-185`): the
/// stable thread id (a UUID) plus the echoed `reasoningEffort` (`protocol.ts:233`).
#[derive(Clone, Debug, PartialEq)]
pub struct StartedThread {
    pub thread_id: String,
    pub reasoning_effort: Option<String>,
    /// Effective settings stated by native start/resume. Absent fields are
    /// deliberately distinguishable from an explicit null native default.
    pub effective_settings: Value,
}

/// `thread/fork` params (the 0.147.0 `ThreadForkParams` generated type): `{threadId,
/// lastTurnId?, model?, cwd?, approvalPolicy?, sandbox?}` — there is **NO `excludeTurns`**:
/// 0.147.0 removed it from the schema (it is silently ignored if sent), and without it
/// `result.thread.turns` is populated so the child rollout keeps full history. `lastTurnId`
/// EXISTS on 0.147.0 ("turns after `last_turn_id` are omitted"; the referenced turn cannot
/// be in progress) — it is the per-turn fork knob (fork through the selected turn).
#[derive(Clone, Debug, Default)]
pub struct ThreadForkParams {
    pub thread_id: String,
    pub last_turn_id: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
}

/// `turn/start` params (`CodexTurnStartParams`, `protocol.ts:303-316`; adapter send,
/// `adapter.ts:971-979`).
///
/// **`effort` is forwarded VERBATIM (DEV-0003).** The caller passes the already wire-mapped
/// value from [`crate::model::to_codex_reasoning_effort`]; the client inserts it unchanged —
/// it never clamps or remaps `none`/`minimal`.
#[derive(Clone, Debug, Default)]
pub struct StartTurnParams {
    pub thread_id: String,
    pub input: Vec<Value>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sandbox_policy: Option<Value>,
    pub approval_policy: Option<Value>,
    pub collaboration_mode: Option<Value>,
}

/// The `turn/start` result (`CodexTurnStartResult`, `protocol.ts:318-320`): the provider turn id.
#[derive(Clone, Debug, PartialEq)]
pub struct StartedTurn {
    pub turn_id: String,
}

type PendingMap = Arc<StdMutex<HashMap<RequestId, oneshot::Sender<Result<Value, RpcError>>>>>;

/// The codex app-server JSON-RPC/WS client (`CodexAppServerClient`, `client.ts:122`).
pub struct CodexAppServerClient {
    transport: Arc<dyn WsTransport>,
    pending: PendingMap,
    next_id: AtomicI64,
    request_timeout: Duration,
    /// The wider budget for `thread/read`/`thread/resume` only (see
    /// [`SNAPSHOT_READ_TIMEOUT_MS`]). Every other RPC stays on `request_timeout`.
    read_timeout: Duration,
    /// Single-flight initialize cache: `Some(result)` once the handshake completed
    /// (`initializePromise`, `client.ts:126,144-166`).
    init: TokioMutex<Option<Value>>,
    /// Unified agent names (Task 2): the `codexHome` captured from the
    /// `initialize` result BEFORE any `Ok(_)`/`StartedThread` reduction —
    /// the initialized root the app-server itself reported (the authority
    /// for where rollouts live, never re-derived from ambient env). Read by
    /// [`Self::codex_home`].
    codex_home: TokioMutex<Option<String>>,
    read_handle: tokio::task::JoinHandle<()>,
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        // Stop the background consumer when the client is dropped (no leaked task).
        self.read_handle.abort();
    }
}

impl CodexAppServerClient {
    pub async fn is_initialized(&self) -> bool {
        self.init.lock().await.is_some()
    }

    /// Read visible model metadata from this connection's own provider context.
    pub async fn list_models(&self, cursor: Option<&str>) -> Result<Value, CodexAppServerError> {
        let mut params = json!({"includeHidden":false,"limit":100});
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        self.request("model/list", params).await
    }
    /// Wire a client to a transport with the default request timeout and the
    /// [`SNAPSHOT_READ_TIMEOUT_MS`] read budget. Returns the client plus the
    /// [`CodexNotification`] stream the background consumer feeds (the adapter's
    /// lifecycle/turn fan-out). Spawns the background read loop immediately.
    pub fn connect(
        transport: Arc<dyn WsTransport>,
    ) -> (Self, mpsc::UnboundedReceiver<CodexNotification>) {
        Self::connect_with_timeouts(
            transport,
            Duration::from_millis(DEFAULT_REQUEST_TIMEOUT_MS),
            Duration::from_millis(SNAPSHOT_READ_TIMEOUT_MS),
        )
    }

    /// [`connect`](Self::connect) with an explicit per-request timeout; the snapshot-read
    /// budget still defaults to [`SNAPSHOT_READ_TIMEOUT_MS`] (use
    /// [`connect_with_timeouts`](Self::connect_with_timeouts) to override both).
    pub fn connect_with_timeout(
        transport: Arc<dyn WsTransport>,
        request_timeout: Duration,
    ) -> (Self, mpsc::UnboundedReceiver<CodexNotification>) {
        Self::connect_with_timeouts(
            transport,
            request_timeout,
            Duration::from_millis(SNAPSHOT_READ_TIMEOUT_MS),
        )
    }

    /// [`connect`](Self::connect) with explicit overrides for both the general per-request
    /// timeout and the `thread/read`/`thread/resume`-only read timeout.
    pub fn connect_with_timeouts(
        transport: Arc<dyn WsTransport>,
        request_timeout: Duration,
        read_timeout: Duration,
    ) -> (Self, mpsc::UnboundedReceiver<CodexNotification>) {
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let read_handle = tokio::spawn(read_loop(transport.clone(), pending.clone(), notify_tx));
        let client = Self {
            transport,
            pending,
            next_id: AtomicI64::new(1),
            request_timeout,
            read_timeout,
            init: TokioMutex::new(None),
            codex_home: TokioMutex::new(None),
            read_handle,
        };
        (client, notify_rx)
    }

    /// The readiness handshake (`initialize`, `client.ts:144-166`): single-flight; on success
    /// sends the `initialized` notification. Idempotent — later calls return the cached result.
    pub async fn initialize(&self) -> Result<Value, CodexAppServerError> {
        let mut guard = self.init.lock().await;
        if let Some(result) = &*guard {
            return Ok(result.clone());
        }
        // client.ts:147-152 — freshell clientInfo + experimental capabilities.
        let params = json!({
            "clientInfo": { "name": "freshell", "version": "1.0.0" },
            "capabilities": {
                "experimentalApi": true,
                "extensions": {"openai/form": {}, "openai/elicitation": {"form": {}}, "openai/standard-form-input": {}},
                "optOutNotificationMethods": ["thread/started"],
            },
        });
        let result = self
            .send_request("initialize", params, self.request_timeout)
            .await?;
        // client.ts:158 — the initialized notification follows a successful initialize.
        self.notify("initialized", None).await?;
        // Unified agent names (Task 2): capture the app-server's own
        // `codexHome` from the initialize result BEFORE the `Ok(_)`
        // reduction — the initialized root later StartedThread results are
        // correlated against (never re-derived from ambient env).
        if let Some(home) = result.get("codexHome").and_then(Value::as_str) {
            if !home.is_empty() {
                *self.codex_home.lock().await = Some(home.to_string());
            }
        }
        *guard = Some(result.clone());
        Ok(result)
    }

    /// Unified agent names (Task 2): the `codexHome` the app-server reported
    /// at initialize — the initialized root rollouts are written under.
    /// `None` before the first successful `initialize`.
    pub async fn codex_home(&self) -> Option<String> {
        self.codex_home.lock().await.clone()
    }

    /// 0.164 may warn and fall back when managed requirements constrain the
    /// requested policy. Check before submitting work; never turn that fallback
    /// into a silent replacement of prepared untrusted intent.
    async fn check_untrusted_requirements(
        &self,
        policy: Option<&str>,
    ) -> Result<(), CodexAppServerError> {
        if policy != Some("untrusted") {
            return Ok(());
        }
        let result = self.request("configRequirements/read", json!({})).await?;
        let requirements =
            result
                .get("requirements")
                .ok_or_else(|| CodexAppServerError::InvalidResponse {
                    method: "configRequirements/read".into(),
                    detail:
                        "missing native requirements while preserving approval_policy untrusted"
                            .into(),
                })?;
        let policies = requirements.get("allowedApprovalPolicies");
        if policies.is_some_and(|policies| {
            !policies.is_null()
                && !policies.as_array().is_some_and(|allowed| {
                    allowed
                        .iter()
                        .any(|policy| policy.as_str() == Some("untrusted"))
                })
        }) {
            tracing::warn!(
                event = "codex.approval_policy_incompatible",
                setting = "approval_policy",
                requested = "untrusted",
                stage = "requirements"
            );
            return Err(CodexAppServerError::InvalidResponse {
                method: "configRequirements/read".into(), detail: "Codex approval_policy untrusted is disallowed by native requirements; prepared approval intent was preserved and no work was submitted".into(),
            });
        }
        Ok(())
    }

    pub fn check_effective_approval_policy(
        result: &Value,
        requested: Option<&str>,
        method: &str,
    ) -> Result<(), CodexAppServerError> {
        if requested == Some("untrusted")
            && result.get("approvalPolicy").and_then(Value::as_str) != requested
        {
            tracing::warn!(
                event = "codex.approval_policy_incompatible",
                setting = "approval_policy",
                requested = "untrusted",
                method,
                stage = "effective_response"
            );
            return Err(CodexAppServerError::InvalidResponse {
                method: method.into(), detail: "native response did not preserve requested approval_policy untrusted; refusing to submit work under a different policy".into(),
            });
        }
        Ok(())
    }

    /// `thread/start` (`client.ts:168-186`) — the stable-from-create codex thread.
    pub async fn start_thread(
        &self,
        params: StartThreadParams,
    ) -> Result<StartedThread, CodexAppServerError> {
        self.check_untrusted_requirements(params.approval_policy.as_deref())
            .await?;
        let requested_policy = params.approval_policy.clone();
        let mut wire = Map::new();
        insert_opt_str(&mut wire, "cwd", params.cwd);
        insert_opt_str(&mut wire, "model", params.model);
        insert_opt_str(&mut wire, "sandbox", params.sandbox);
        insert_opt_str(&mut wire, "approvalPolicy", params.approval_policy);
        if let Some(mode) = params.history_mode {
            // LBC-1 (kata 1wxv Task 2): threads freshell starts are paginated so
            // `thread/revert` accepts them.
            wire.insert("historyMode".to_string(), json!(mode.wire_name()));
        }
        // client.ts:172-173 — the client's fixed additions.
        wire.insert("experimentalRawEvents".to_string(), json!(false));
        wire.insert("persistExtendedHistory".to_string(), json!(true));

        let result = self.request("thread/start", Value::Object(wire)).await?;
        Self::check_effective_approval_policy(
            &result,
            requested_policy.as_deref(),
            "thread/start",
        )?;
        let thread_id = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CodexAppServerError::InvalidResponse {
                method: "thread/start".to_string(),
                detail: "missing thread.id".to_string(),
            })?
            .to_string();
        let reasoning_effort = result
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(StartedThread {
            thread_id,
            reasoning_effort,
            effective_settings: effective_thread_settings(&result),
        })
    }

    /// `thread/resume` (`client.ts:188-204`) -- resumes an EXISTING thread by id (as opposed
    /// to `thread/start`'s "mint a new thread"). Used by [`Self::read_thread`]'s callers to
    /// bring an on-disk-only thread (one this sidecar has never seen) back onto a live
    /// app-server connection WITHOUT changing its id, mirroring the reference's
    /// `ensureRuntime` (`adapter.ts:762-799`) -- unlike this crate's own crash-recovery path
    /// (which mints a NEW thread id on respawn), `thread/resume` preserves the caller's id.
    pub async fn resume_thread(
        &self,
        thread_id: &str,
        params: StartThreadParams,
    ) -> Result<StartedThread, CodexAppServerError> {
        self.check_untrusted_requirements(params.approval_policy.as_deref())
            .await?;
        let requested_policy = params.approval_policy.clone();
        let mut wire = Map::new();
        wire.insert("threadId".to_string(), json!(thread_id));
        insert_opt_str(&mut wire, "cwd", params.cwd);
        insert_opt_str(&mut wire, "model", params.model);
        insert_opt_str(&mut wire, "sandbox", params.sandbox);
        insert_opt_str(&mut wire, "approvalPolicy", params.approval_policy);
        // client.ts:192 -- resume preserves the app-server's default raw-event behavior
        // (no `experimentalRawEvents` override), only fixing `persistExtendedHistory`.
        wire.insert("persistExtendedHistory".to_string(), json!(true));

        // Runs under `read_timeout` (SNAPSHOT_READ_TIMEOUT_MS), not `request_timeout` --
        // resuming a historical thread to serve a snapshot shares the same cold-load-vs-large-
        // thread latency risk as `thread/read` (see SNAPSHOT_READ_TIMEOUT_MS's doc comment).
        let result = self
            .request_with_timeout("thread/resume", Value::Object(wire), self.read_timeout)
            .await?;
        Self::check_effective_approval_policy(
            &result,
            requested_policy.as_deref(),
            "thread/resume",
        )?;
        let resumed_thread_id = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CodexAppServerError::InvalidResponse {
                method: "thread/resume".to_string(),
                detail: "missing thread.id".to_string(),
            })?
            .to_string();
        let reasoning_effort = result
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(StartedThread {
            thread_id: resumed_thread_id,
            reasoning_effort,
            effective_settings: effective_thread_settings(&result),
        })
    }

    /// `thread/fork` (0.147.0) — fork `thread_id` into a NEW child thread that this
    /// app-server connection then owns (the child shares the parent's rollout lineage).
    /// The wire shape carries NO `excludeTurns` (see [`ThreadForkParams`]). Returns the
    /// raw result `Value`; the CALLER parses `.thread.id` (parsed loosely — a
    /// malformed success payload is the caller's guard, not a decode here).
    pub async fn fork_thread(
        &self,
        params: ThreadForkParams,
    ) -> Result<Value, CodexAppServerError> {
        self.check_untrusted_requirements(params.approval_policy.as_deref())
            .await?;
        let mut wire = Map::new();
        wire.insert("threadId".to_string(), json!(params.thread_id));
        insert_opt_str(&mut wire, "lastTurnId", params.last_turn_id);
        insert_opt_str(&mut wire, "model", params.model);
        insert_opt_str(&mut wire, "cwd", params.cwd);
        insert_opt_str(&mut wire, "approvalPolicy", params.approval_policy);
        insert_opt_str(&mut wire, "sandbox", params.sandbox);
        self.request("thread/fork", Value::Object(wire)).await
    }

    /// `thread/archive` (0.147.0) — archive a thread, RELEASING its writer lock so the
    /// thread is no longer owned by this connection. The result is a generic success
    /// payload; awaiting it is enough (no fields are consumed). In the fork handoff
    /// (VALIDATED, LB-01 real 0.147.0 probe) this is what lets a SECOND app-server
    /// connection then unarchive+resume the child (a direct cross-process
    /// `thread/resume` while the parent owns it is rejected with `-32600 "thread …
    /// already has an active writer"`).
    pub async fn archive_thread(&self, thread_id: &str) -> Result<(), CodexAppServerError> {
        self.request("thread/archive", json!({ "threadId": thread_id }))
            .await?;
        Ok(())
    }

    /// `thread/unarchive` (0.147.0) — unarchive a thread (restores visibility; does
    /// NOT claim a writer). The result is a generic success payload; awaiting it is
    /// enough. See [`Self::archive_thread`] for the fork handoff this pairs with.
    pub async fn unarchive_thread(&self, thread_id: &str) -> Result<(), CodexAppServerError> {
        self.request("thread/unarchive", json!({ "threadId": thread_id }))
            .await?;
        Ok(())
    }

    /// `thread/revert` (codex 0.149.0, EXPERIMENTAL; kata 1wxv Task 2) — the
    /// in-place, same-thread-id conversation rollback: durable history is
    /// replaced by the prefix strictly BEFORE `before_turn_id` (an empty prefix
    /// — reverting before the first turn — LEGALLY empties the thread).
    /// Conversation-only (the provider leaves files to the client) and
    /// DESTRUCTIVE — there is no native redo, so the caller captures the
    /// removed tail BEFORE issuing this RPC. Refuses legacy threads with
    /// `-32600 "thread/revert only supports paginated threads"`.
    pub async fn revert_thread(
        &self,
        thread_id: &str,
        before_turn_id: &str,
    ) -> Result<(), CodexAppServerError> {
        self.request(
            "thread/revert",
            json!({ "threadId": thread_id, "beforeTurnId": before_turn_id }),
        )
        .await?;
        Ok(())
    }

    /// `turn/start` (`client.ts:424-431`; adapter send `adapter.ts:971-979`). **Forwards
    /// `effort` VERBATIM (DEV-0003)** — the value the caller supplies is inserted unchanged.
    pub async fn start_turn(
        &self,
        params: StartTurnParams,
    ) -> Result<StartedTurn, CodexAppServerError> {
        self.check_untrusted_requirements(params.approval_policy.as_ref().and_then(Value::as_str))
            .await?;
        let mut wire = Map::new();
        wire.insert("threadId".to_string(), json!(params.thread_id));
        wire.insert("input".to_string(), Value::Array(params.input));
        insert_opt_str(&mut wire, "cwd", params.cwd);
        if let Some(policy) = params.approval_policy {
            wire.insert("approvalPolicy".to_string(), policy);
        }
        if let Some(policy) = params.sandbox_policy {
            wire.insert("sandboxPolicy".to_string(), policy);
        }
        insert_opt_str(&mut wire, "model", params.model);
        // DEV-0003: the reasoning effort crosses the wire EXACTLY as given (no clamp/remap).
        insert_opt_str(&mut wire, "effort", params.effort);
        if let Some(mode) = params.collaboration_mode {
            wire.insert("collaborationMode".to_string(), mode);
        }

        let result = self.request("turn/start", Value::Object(wire)).await?;
        let turn_id = result
            .get("turn")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CodexAppServerError::InvalidResponse {
                method: "turn/start".to_string(),
                detail: "missing turn.id".to_string(),
            })?
            .to_string();
        Ok(StartedTurn { turn_id })
    }

    /// Active input belongs to the exact native turn the caller observed.
    /// Native steer accepts no setting overrides and returns that same turn ID.
    pub async fn steer_turn(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        input: Vec<Value>,
    ) -> Result<StartedTurn, CodexAppServerError> {
        let result = self
            .request(
                "turn/steer",
                json!({"threadId": thread_id, "expectedTurnId": expected_turn_id, "input": input}),
            )
            .await?;
        let turn_id = result
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|id| *id == expected_turn_id)
            .ok_or_else(|| CodexAppServerError::InvalidResponse {
                method: "turn/steer".into(),
                detail: "missing or mismatched turnId".into(),
            })?;
        Ok(StartedTurn {
            turn_id: turn_id.into(),
        })
    }

    /// `turn/interrupt` (`client.ts:433-439`). A successful reply acknowledges
    /// submission only; it is never terminal-turn evidence.
    pub async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), CodexAppServerError> {
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await?;
        Ok(())
    }

    /// `thread/compact/start` (the 0.147.0 `ThreadCompactStartParams` RPC). Params are
    /// `{threadId}` ONLY — the schema has NO instructions field, so any client
    /// `instructions` are dropped by the CALLER (never synthesized or turn-texted here;
    /// fresh-eyes round-2 F5). Awaiting the `Record<string, never>` response is merely
    /// the acceptance edge: the compact TURN itself arrives afterwards as the probed
    /// notification sequence (`thread/status/changed{active}` → `turn/started` → … →
    /// `turn/completed`) on the session's existing notification consumer.
    pub async fn compact_thread(&self, thread_id: &str) -> Result<(), CodexAppServerError> {
        self.request("thread/compact/start", json!({ "threadId": thread_id }))
            .await?;
        Ok(())
    }

    /// `thread/read` (`client.ts readThread`; adapter usage `adapter.ts:1089,1094`) \u2014 fetch the
    /// full thread record (`{ thread: {\u2026} }`), optionally with its turns embedded
    /// (`includeTurns`). Returns the raw JSON result verbatim; the fresh-agent REST snapshot
    /// surface normalizes it (mirrors `getSnapshot`'s `runtime.readThread` call).
    pub async fn read_thread(
        &self,
        thread_id: &str,
        include_turns: bool,
    ) -> Result<Value, CodexAppServerError> {
        // Runs under `read_timeout` (SNAPSHOT_READ_TIMEOUT_MS), not `request_timeout` -- see
        // SNAPSHOT_READ_TIMEOUT_MS's doc comment for the real-data evidence.
        self.request_with_timeout(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": include_turns }),
            self.read_timeout,
        )
        .await
    }

    /// Unified agent names (Task 3): the native-names METADATA read —
    /// `thread/read` with `includeTurns:false`, bounded to the plan's
    /// 20-second native request budget
    /// ([`NATIVE_METADATA_READ_TIMEOUT_MS`]) instead of this client's 30s
    /// snapshot budget: a name-synchronization read never parses a huge
    /// thread's turns, and the serial native worker must not park on it
    /// past the plan's per-request bound.
    pub async fn read_thread_metadata(
        &self,
        thread_id: &str,
    ) -> Result<Value, CodexAppServerError> {
        self.request_with_timeout(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": false }),
            Duration::from_millis(NATIVE_METADATA_READ_TIMEOUT_MS),
        )
        .await
    }

    /// Unified agent names (Task 3): `thread/name/set` — set the native name
    /// of a thread this connection can address (loaded threads and persisted
    /// rollouts alike — the official API supports name/set for both, so an
    /// existing management connection can name a CLOSED session without
    /// resuming it or claiming its execution lease). The CALLER owns the
    /// root-match policy: only a connection whose initialized `codexHome`
    /// ([`Self::codex_home`]) matches the retained location may dispatch
    /// management writes. Errors preserve the caller's pending/durable name —
    /// this RPC never rolls a canonical name back.
    pub async fn set_thread_name(
        &self,
        thread_id: &str,
        name: &str,
    ) -> Result<(), CodexAppServerError> {
        self.request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": name }),
        )
        .await?;
        Ok(())
    }

    /// `thread/loaded/list` — the ids of threads this app-server currently
    /// has loaded in memory (result shape `{ data: string[], nextCursor? }`,
    /// contract-foundation plan §thread/loaded/list; the committed fixture
    /// returns `{ data: behavior.loadedThreadIds }`). NOTE: `loaded` alone
    /// does NOT mean mid-turn — idle threads stay loaded forever
    /// (reports/V1.md); pair with [`Self::read_thread`]'s status. Added for
    /// Task 9's sweep probe.
    pub async fn list_loaded_threads(&self) -> Result<Vec<String>, CodexAppServerError> {
        let result = self.request("thread/loaded/list", json!({})).await?;
        // Absent/non-array `data` is NOT an empty list: the sweep probe reads
        // Ok(vec![]) as proof of "reachable, no loaded threads" and may REAP
        // on it — a malformed payload must fail loudly instead, sending the
        // caller down the conservative writer-evidence path (final review F2).
        let Some(ids) = result.get("data").and_then(Value::as_array) else {
            return Err(CodexAppServerError::InvalidResponse {
                method: "thread/loaded/list".to_string(),
                detail: format!("expected result.data to be an array, got: {result}"),
            });
        };
        Ok(ids
            .iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect())
    }

    /// Send a notification frame (no response awaited) — `notify`, `client.ts:805-808`.
    pub async fn notify(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), CodexAppServerError> {
        let frame = build_notification_frame(method, params.as_ref());
        self.transport
            .send(frame)
            .await
            .map_err(|message| CodexAppServerError::Transport {
                method: method.to_string(),
                message,
            })
    }

    /// Answer a provider-initiated request using its original JSON-RPC id.
    pub async fn respond(&self, id: &RequestId, result: Value) -> Result<(), CodexAppServerError> {
        self.transport
            .send(json!({ "id": id.to_json(), "result": result }).to_string())
            .await
            .map_err(|message| CodexAppServerError::Transport {
                method: "server-request/respond".into(),
                message,
            })
    }

    pub async fn reject_request(
        &self,
        id: &RequestId,
        message: &str,
    ) -> Result<(), CodexAppServerError> {
        self.transport
            .send(
                json!({ "id": id.to_json(), "error": { "code": -32601, "message": message } })
                    .to_string(),
            )
            .await
            .map_err(|message| CodexAppServerError::Transport {
                method: "server-request/reject".into(),
                message,
            })
    }

    /// Close the transport and fail any in-flight requests (`close`, `client.ts:441-470`).
    pub async fn close(&self) {
        fail_all_pending(&self.pending, "connection closed");
        self.transport.close().await;
    }

    // ── internals ───────────────────────────────────────────────────────────────────────

    /// Every non-`initialize` request awaits the handshake first (`client.ts:777-778`), then
    /// runs under the default `request_timeout`. See [`Self::request_with_timeout`] for the
    /// `thread/read`/`thread/resume`-only override.
    async fn request(&self, method: &str, params: Value) -> Result<Value, CodexAppServerError> {
        self.request_with_timeout(method, params, self.request_timeout)
            .await
    }

    /// [`Self::request`] with an explicit per-call timeout override. Used by
    /// [`Self::read_thread`]/[`Self::resume_thread`] to run under `read_timeout`
    /// (`SNAPSHOT_READ_TIMEOUT_MS`) instead of the shorter `request_timeout` every other RPC
    /// (`turn/start`, `turn/interrupt`, etc.) stays on.
    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CodexAppServerError> {
        if method != "initialize" {
            self.initialize().await?;
        }
        self.send_request(method, params, timeout).await
    }

    /// The raw request/response round-trip: allocate an integer id, register the pending
    /// oneshot, send `{ id, method, params }`, and await the correlated reply under the
    /// given request timeout (`client.ts:776-803`).
    async fn send_request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CodexAppServerError> {
        let id = RequestId::Int(self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map")
            .insert(id.clone(), tx);

        let frame = build_request_frame(&id, method, &params);
        if let Err(message) = self.transport.send(frame).await {
            self.pending.lock().expect("pending map").remove(&id);
            return Err(CodexAppServerError::Transport {
                method: method.to_string(),
                message,
            });
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(error))) => Err(CodexAppServerError::Rpc {
                method: method.to_string(),
                error,
            }),
            // The sender was dropped without a value → the connection closed.
            Ok(Err(_)) => Err(CodexAppServerError::Closed {
                method: method.to_string(),
            }),
            Err(_) => {
                self.pending.lock().expect("pending map").remove(&id);
                Err(CodexAppServerError::Timeout {
                    method: method.to_string(),
                    timeout_ms: timeout.as_millis() as u64,
                })
            }
        }
    }
}

/// The background consumer (`installSocketHandlers` + `handleSocketMessage`,
/// `client.ts:558-641`): resolve responses/errors against the pending map, classify and
/// stream notifications. On close, fail all pending requests (`handleSocketClose`,
/// `client.ts:716-733`).
async fn read_loop(
    transport: Arc<dyn WsTransport>,
    pending: PendingMap,
    notify_tx: mpsc::UnboundedSender<CodexNotification>,
) {
    loop {
        let Some(frame) = transport.recv().await else {
            break;
        };
        match parse_incoming_frame(&frame) {
            Some(IncomingMessage::Request { id, method, params }) => {
                let _ = notify_tx.send(CodexNotification::ServerRequest { id, method, params });
            }
            Some(IncomingMessage::Response { id, result }) => {
                resolve_pending(&pending, &id, Ok(result))
            }
            Some(IncomingMessage::RpcError { id, error }) => {
                resolve_pending(&pending, &id, Err(error))
            }
            Some(IncomingMessage::Notification { method, params }) => {
                let notification = classify_notification(&method, params.as_ref());
                // The consumer being gone is not fatal — matches the reference dropping events
                // with no registered handler.
                let _ = notify_tx.send(notification);
            }
            None => { /* malformed / unrecognized frame → dropped (client.ts:571-573) */ }
        }
    }
    fail_all_pending(&pending, "connection closed");
}

fn resolve_pending(pending: &PendingMap, id: &RequestId, outcome: Result<Value, RpcError>) {
    // Late replies after a timeout/close find no pending entry and are ignored (client.ts:621-623).
    if let Some(tx) = pending.lock().expect("pending map").remove(id) {
        let _ = tx.send(outcome);
    }
}

fn fail_all_pending(pending: &PendingMap, _reason: &str) {
    let mut guard = pending.lock().expect("pending map");
    for (_, tx) in guard.drain() {
        // Dropping the sender (via a closed Err) resolves the waiter's `Ok(Err(_))` → Closed.
        drop(tx);
    }
}

fn effective_thread_settings(response: &Value) -> Value {
    let mut settings = Map::new();
    for key in [
        "model",
        "reasoningEffort",
        "cwd",
        "sandbox",
        "approvalPolicy",
        "collaborationMode",
    ] {
        if let Some(value) = response.get(key) {
            settings.insert(key.into(), value.clone());
        }
    }
    Value::Object(settings)
}

fn insert_opt_str(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_string(), json!(value));
    }
}

// ── ChannelTransport: an in-memory loopback transport for tests + scripted drives ────────

/// An in-memory [`WsTransport`] backed by unbounded channels — the network-free double the
/// tests (and the future scripted harness) drive with the fake-app-server's message shapes.
/// Pair it with a [`ChannelPeer`] via [`new_channel_transport`].
pub struct ChannelTransport {
    to_server: mpsc::UnboundedSender<String>,
    from_server: TokioMutex<mpsc::UnboundedReceiver<String>>,
    closed: AtomicBool,
}

impl WsTransport for ChannelTransport {
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if self.closed.load(Ordering::SeqCst) {
                return Err("transport closed".to_string());
            }
            self.to_server
                .send(text)
                .map_err(|_| "peer dropped".to_string())
        })
    }

    fn recv(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { self.from_server.lock().await.recv().await })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.closed.store(true, Ordering::SeqCst);
            self.from_server.lock().await.close();
        })
    }
}

/// The server end of a [`ChannelTransport`]: read what the client sent, push replies /
/// notifications back. Its API mirrors a scripted `codex app-server`.
pub struct ChannelPeer {
    to_client: mpsc::UnboundedSender<String>,
    from_client: TokioMutex<mpsc::UnboundedReceiver<String>>,
}

impl ChannelPeer {
    /// Send a provider-initiated request to exercise the bidirectional RPC path.
    pub fn request_client(&self, id: &RequestId, method: &str, params: Value) {
        let _ = self
            .to_client
            .send(build_request_frame(id, method, &params));
    }

    pub async fn next_raw_frame(&self) -> Option<Value> {
        let raw = self.from_client.lock().await.recv().await?;
        serde_json::from_str(&raw).ok()
    }
    /// Await the next client→server frame, decoded (`None` when the client dropped).
    pub async fn next_frame(&self) -> Option<ClientFrame> {
        let raw = self.from_client.lock().await.recv().await?;
        parse_client_frame(&raw)
    }

    /// Await the next client REQUEST, panicking if a notification arrives first (test ergonomics).
    pub async fn expect_request(&self) -> (RequestId, String, Value) {
        match self.next_frame().await.expect("client frame") {
            ClientFrame::Request { id, method, params } => (id, method, params),
            ClientFrame::Notification { method, .. } => {
                panic!("expected a request, got notification {method}")
            }
        }
    }

    /// Await the next client NOTIFICATION, panicking if a request arrives first.
    pub async fn expect_notification(&self) -> (String, Option<Value>) {
        match self.next_frame().await.expect("client frame") {
            ClientFrame::Notification { method, params } => (method, params),
            ClientFrame::Request { method, .. } => {
                panic!("expected a notification, got request {method}")
            }
        }
    }

    /// Push a success reply `{ id, result }` to the client.
    pub fn respond(&self, id: &RequestId, result: Value) {
        let frame = match id {
            RequestId::Int(n) => json!({ "id": n, "result": result }),
            RequestId::Str(s) => json!({ "id": s, "result": result }),
        };
        let _ = self.to_client.send(frame.to_string());
    }

    /// Push an error reply `{ id, error:{code,message} }` to the client.
    pub fn respond_error(&self, id: &RequestId, code: i64, message: &str) {
        let frame = match id {
            RequestId::Int(n) => json!({ "id": n, "error": { "code": code, "message": message } }),
            RequestId::Str(s) => json!({ "id": s, "error": { "code": code, "message": message } }),
        };
        let _ = self.to_client.send(frame.to_string());
    }

    /// Broadcast a notification `{ jsonrpc:'2.0', method, params }` to the client (the fake
    /// app-server tags notifications with `jsonrpc`, `fake-app-server.mjs:320-325`).
    pub fn emit_notification(&self, method: &str, params: Value) {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.to_client.send(frame.to_string());
    }

    /// Drop the server→client channel, simulating a connection close.
    pub fn disconnect(self) {
        drop(self.to_client);
    }
}

/// Build a paired [`ChannelTransport`] (client end) and [`ChannelPeer`] (server end).
pub fn new_channel_transport() -> (Arc<ChannelTransport>, ChannelPeer) {
    let (to_server, from_client) = mpsc::unbounded_channel();
    let (to_client, from_server) = mpsc::unbounded_channel();
    let transport = Arc::new(ChannelTransport {
        to_server,
        from_server: TokioMutex::new(from_server),
        closed: AtomicBool::new(false),
    });
    let peer = ChannelPeer {
        to_client,
        from_client: TokioMutex::new(from_client),
    };
    (transport, peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_native_pre_admission_errors_are_refusals() {
        for message in [
            "no active turn to steer",
            "no active turn to interrupt",
            "expected active turn id `old` but found `new`",
        ] {
            assert!(CodexAppServerError::Rpc {
                method: "turn/steer".into(),
                error: RpcError {
                    code: -32600,
                    message: message.into(),
                    data: None
                }
            }
            .is_not_submitted());
        }
        for error in [
            CodexAppServerError::Rpc {
                method: "turn/start".into(),
                error: RpcError {
                    code: -32603,
                    message: "internal failure".into(),
                    data: None,
                },
            },
            CodexAppServerError::Timeout {
                method: "turn/start".into(),
                timeout_ms: 100,
            },
            CodexAppServerError::Closed {
                method: "turn/steer".into(),
            },
            CodexAppServerError::Transport {
                method: "turn/interrupt".into(),
                message: "lost transport reply".into(),
            },
            CodexAppServerError::InvalidResponse {
                method: "turn/start".into(),
                detail: "missing result".into(),
            },
        ] {
            assert!(!error.is_not_submitted(), "{error}");
        }
        assert!(CodexAppServerError::Timeout {
            method: "initialize".into(),
            timeout_ms: 100
        }
        .is_not_submitted());
    }

    #[cfg(feature = "native-policy-qualification")]
    #[tokio::test]
    async fn native_requirements_refuse_untrusted_before_work() {
        struct RecordingTransport {
            native: crate::transport::TungsteniteTransport,
            frames: Arc<StdMutex<Vec<Value>>>,
        }
        impl WsTransport for RecordingTransport {
            fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>> {
                Box::pin(async move {
                    self.frames.lock().unwrap().push(json!({"direction":"controller", "frame":serde_json::from_str::<Value>(&text).unwrap()}));
                    self.native.send(text).await
                })
            }
            fn recv(&self) -> BoxFuture<'_, Option<String>> {
                Box::pin(async move {
                    let text = self.native.recv().await?;
                    self.frames.lock().unwrap().push(json!({"direction":"native", "frame":serde_json::from_str::<Value>(&text).unwrap()}));
                    Some(text)
                })
            }
            fn close(&self) -> BoxFuture<'_, ()> {
                self.native.close()
            }
        }
        let endpoint = std::env::var("FRESHELL_CODEX_POLICY_PROBE_URL")
            .expect("explicit owned native endpoint required");
        assert!(endpoint.starts_with("ws://127.0.0.1:"));
        let receipt_path = std::env::var("FRESHELL_CODEX_POLICY_PROBE_RECEIPT")
            .expect("explicit owned receipt required");
        let frames = Arc::new(StdMutex::new(Vec::<Value>::new()));
        let transport = RecordingTransport {
            native: crate::transport::TungsteniteTransport::connect(&endpoint)
                .await
                .unwrap(),
            frames: frames.clone(),
        };
        let (client, _notifications) = CodexAppServerClient::connect(Arc::new(transport));
        let mut refused = Vec::new();
        for route in ["create", "resume", "fork", "send"] {
            let params = StartThreadParams {
                approval_policy: Some("untrusted".into()),
                ..Default::default()
            };
            let parent = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";
            let result = match route {
                "create" => client.start_thread(params).await.map(|_| ()),
                "resume" => client.resume_thread(parent, params).await.map(|_| ()),
                "fork" => client
                    .fork_thread(ThreadForkParams {
                        thread_id: parent.into(),
                        approval_policy: Some("untrusted".into()),
                        ..Default::default()
                    })
                    .await
                    .map(|_| ()),
                _ => client
                    .start_turn(StartTurnParams {
                        thread_id: parent.into(),
                        approval_policy: Some(json!("untrusted")),
                        input: vec![json!({"type":"text","text":"must remain unsubmitted"})],
                        ..Default::default()
                    })
                    .await
                    .map(|_| ()),
            };
            let error = result.expect_err("native requirements must refuse before work");
            assert!(
                matches!(&error, CodexAppServerError::InvalidResponse { method, .. } if method == "configRequirements/read"),
                "{route}: {error}"
            );
            assert!(error.to_string().contains("approval_policy untrusted"));
            refused.push(route);
        }
        client.close().await;
        let frames = frames.lock().unwrap();
        let requests: Vec<_> = frames
            .iter()
            .filter(|entry| entry["direction"] == "controller")
            .map(|entry| &entry["frame"])
            .collect();
        assert_eq!(
            requests
                .iter()
                .filter(|frame| frame["method"] == "configRequirements/read")
                .count(),
            4
        );
        assert!(requests.iter().all(|frame| matches!(
            frame["method"].as_str(),
            Some("initialize" | "initialized" | "configRequirements/read")
        )));
        let replies: Vec<_> = frames
            .iter()
            .filter(|entry| {
                entry["direction"] == "native"
                    && entry["frame"]["result"]["requirements"]["allowedApprovalPolicies"]
                        .is_array()
            })
            .collect();
        assert_eq!(replies.len(), 4);
        assert!(replies
            .iter()
            .all(
                |entry| entry["frame"]["result"]["requirements"]["allowedApprovalPolicies"]
                    == json!(["never"])
            ));
        let receipt = json!({"event":"codex_native_policy_client_proof", "severity":"info", "refusedRoutes":refused, "frames":*frames, "workRequests":0});
        std::fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
        println!(
            "{}",
            json!({"event":"codex_native_policy_client_proof", "severity":"info", "refusedRoutes":refused, "workRequests":0})
        );
    }

    fn started_thread_result() -> Value {
        json!({ "thread": { "id": "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e" }, "reasoningEffort": "none" })
    }

    #[tokio::test]
    async fn untrusted_requirements_refuse_before_native_work_on_every_typed_route() {
        for route in ["create", "resume", "fork", "send"] {
            let (transport, peer) = new_channel_transport();
            let (client, _notifications) = CodexAppServerClient::connect(transport);
            let task = tokio::spawn(async move {
                let params = StartThreadParams {
                    approval_policy: Some("untrusted".into()),
                    ..Default::default()
                };
                match route {
                    "create" => client.start_thread(params).await.map(|_| ()),
                    "resume" => client.resume_thread("parent", params).await.map(|_| ()),
                    "fork" => client
                        .fork_thread(ThreadForkParams {
                            thread_id: "parent".into(),
                            approval_policy: Some("untrusted".into()),
                            ..Default::default()
                        })
                        .await
                        .map(|_| ()),
                    _ => client
                        .start_turn(StartTurnParams {
                            thread_id: "parent".into(),
                            approval_policy: Some(json!("untrusted")),
                            input: vec![json!({"type":"text","text":"must remain unsubmitted"})],
                            ..Default::default()
                        })
                        .await
                        .map(|_| ()),
                }
            });
            let (init, method, _) = peer.expect_request().await;
            assert_eq!(method, "initialize");
            peer.respond(&init, json!({"userAgent":"fixture", "codexHome":"/fixture", "platformFamily":"unix", "platformOs":"linux"}));
            peer.expect_notification().await;
            let (id, method, _) = peer.expect_request().await;
            assert_eq!(
                method, "configRequirements/read",
                "{route} must check native requirements before work"
            );
            peer.respond(
                &id,
                json!({"requirements":{"allowedApprovalPolicies":["never"]}}),
            );
            let error = task
                .await
                .unwrap()
                .expect_err("native requirement fallback must be refused");
            assert!(error.to_string().contains("approval_policy"));
            assert!(error.to_string().contains("untrusted"));
        }
    }

    #[tokio::test]
    async fn untrusted_native_effective_policy_mismatch_is_not_accepted() {
        for route in ["create", "resume"] {
            let (transport, peer) = new_channel_transport();
            let (client, _notifications) = CodexAppServerClient::connect(transport);
            let task = tokio::spawn(async move {
                let params = StartThreadParams {
                    approval_policy: Some("untrusted".into()),
                    ..Default::default()
                };
                if route == "create" {
                    client.start_thread(params).await
                } else {
                    client.resume_thread("parent", params).await
                }
            });
            let (init, _, _) = peer.expect_request().await;
            peer.respond(&init, json!({"userAgent":"fixture", "codexHome":"/fixture", "platformFamily":"unix", "platformOs":"linux"}));
            peer.expect_notification().await;
            let (mut id, mut method, _) = peer.expect_request().await;
            if method == "configRequirements/read" {
                peer.respond(&id, json!({"requirements":null}));
                (id, method, _) = peer.expect_request().await;
            }
            assert_eq!(
                method,
                if route == "create" {
                    "thread/start"
                } else {
                    "thread/resume"
                }
            );
            peer.respond(
                &id,
                json!({"thread":{"id":"minted-or-resumed"}, "approvalPolicy":"never"}),
            );
            assert!(
                task.await.unwrap().is_err(),
                "returned native effective policy must not silently replace untrusted intent"
            );
        }
    }

    #[tokio::test]
    async fn initialize_handshake_sends_request_then_initialized_notification() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.initialize().await });

        // The first frame is the initialize REQUEST.
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "initialize");
        assert_eq!(params["clientInfo"]["name"], json!("freshell"));
        peer.respond(&id, json!({ "userAgent": "codex", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));

        // The second frame is the initialized NOTIFICATION (no id).
        let (note_method, note_params) = peer.expect_notification().await;
        assert_eq!(note_method, "initialized");
        assert_eq!(note_params, None);

        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn non_initialize_request_gates_on_initialize_first() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.start_thread(StartThreadParams::default()).await });

        // start_thread must trigger initialize FIRST.
        let (init_id, init_method, _) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        // THEN thread/start.
        let (start_id, start_method, params) = peer.expect_request().await;
        assert_eq!(start_method, "thread/start");
        assert_eq!(params["persistExtendedHistory"], json!(true));
        peer.respond(&start_id, started_thread_result());

        let started = task.await.unwrap().unwrap();
        assert_eq!(started.thread_id, "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e");
    }

    #[tokio::test]
    async fn start_turn_forwards_effort_verbatim_on_the_wire() {
        // DEV-0003: none/minimal must cross the wire unchanged.
        for effort in ["none", "minimal", "low", "medium", "high"] {
            let (transport, peer) = new_channel_transport();
            let (client, _notifs) = CodexAppServerClient::connect(transport);
            let client = Arc::new(client);

            let c = client.clone();
            let turn_effort = effort.to_string();
            let task = tokio::spawn(async move {
                c.start_turn(StartTurnParams {
                    collaboration_mode: None,
                    thread_id: "thread-1".to_string(),
                    input: vec![json!({ "type": "text", "text": "hi" })],
                    cwd: None,
                    model: Some("gpt-5.3-codex-spark".to_string()),
                    effort: Some(turn_effort),
                    sandbox_policy: None,
                    approval_policy: None,
                })
                .await
            });

            // initialize handshake
            let (init_id, _m, _p) = peer.expect_request().await;
            peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
            let _ = peer.expect_notification().await;

            // turn/start — assert the effort field is VERBATIM.
            let (turn_id, method, params) = peer.expect_request().await;
            assert_eq!(method, "turn/start");
            assert_eq!(
                params["effort"],
                json!(effort),
                "effort {effort} must forward verbatim"
            );
            assert_eq!(params["threadId"], json!("thread-1"));
            peer.respond(&turn_id, json!({ "turn": { "id": "turn-1" } }));

            assert_eq!(
                task.await.unwrap().unwrap(),
                StartedTurn {
                    turn_id: "turn-1".to_string()
                }
            );
        }
    }

    #[tokio::test]
    async fn read_thread_sends_thread_id_and_include_turns_and_returns_raw_result() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.read_thread("thread-1", true).await });

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let _ = peer.expect_notification().await;

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/read");
        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["includeTurns"], json!(true));
        peer.respond(
            &id,
            json!({ "thread": { "id": "thread-1", "status": { "type": "idle" }, "turns": [] } }),
        );

        let result = task.await.unwrap().unwrap();
        assert_eq!(result["thread"]["id"], json!("thread-1"));
    }

    #[tokio::test]
    async fn turn_completed_notification_reaches_the_consumer() {
        let (transport, peer) = new_channel_transport();
        let (client, mut notifs) = CodexAppServerClient::connect(transport);
        let _client = Arc::new(client);

        // The server can push a notification at any time; the background consumer classifies it.
        peer.emit_notification(
            "turn/completed",
            json!({ "threadId": "thread-1", "turnId": "turn-1", "status": "completed" }),
        );

        let n = notifs.recv().await.expect("a notification");
        match n {
            CodexNotification::TurnCompleted(ev) => {
                assert_eq!(ev.thread_id, "thread-1");
                assert_eq!(ev.turn_id.as_deref(), Some("turn-1"));
            }
            other => panic!("expected TurnCompleted, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_error_reply_surfaces_as_rpc_error() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.initialize().await });
        let (id, _m, _p) = peer.expect_request().await;
        peer.respond_error(&id, -32000, "boom");

        match task.await.unwrap() {
            Err(CodexAppServerError::Rpc { method, error }) => {
                assert_eq!(method, "initialize");
                assert_eq!(error.code, -32000);
                assert_eq!(error.message, "boom");
            }
            other => panic!("expected an Rpc error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn request_times_out_when_the_server_never_replies() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) =
            CodexAppServerClient::connect_with_timeout(transport, Duration::from_millis(40));
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.initialize().await });
        // Read the request but never respond.
        let (_id, method, _p) = peer.expect_request().await;
        assert_eq!(method, "initialize");

        match task.await.unwrap() {
            Err(CodexAppServerError::Timeout { method, .. }) => assert_eq!(method, "initialize"),
            other => panic!("expected a Timeout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn disconnect_fails_inflight_requests_as_closed() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) =
            CodexAppServerClient::connect_with_timeout(transport, Duration::from_secs(30));
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.initialize().await });
        let (_id, _m, _p) = peer.expect_request().await;
        // Drop the server→client channel → the read loop ends → pending requests fail as Closed.
        peer.disconnect();

        match task.await.unwrap() {
            Err(CodexAppServerError::Closed { method }) => assert_eq!(method, "initialize"),
            other => panic!("expected Closed, got {other:?}"),
        }
    }

    // ── snapshot-read timeout budget (thread/read, thread/resume) ──────────────────────

    #[test]
    fn snapshot_read_timeout_ms_matches_the_documented_30_second_budget() {
        // Pins the deliberate deviation's value: real-data evidence proved 5s (legacy's
        // uniform DEFAULT_REQUEST_TIMEOUT_MS, client.ts:65,141) is too tight for a large
        // thread/read; capped at 30s (a REST fetch shouldn't hang forever).
        assert_eq!(SNAPSHOT_READ_TIMEOUT_MS, 30_000);
    }

    #[tokio::test]
    async fn read_thread_honors_the_longer_read_timeout_not_the_request_timeout() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect_with_timeouts(
            transport,
            Duration::from_millis(50),
            Duration::from_millis(400),
        );
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.read_thread("thread-1", true).await });

        let (init_id, init_method, _) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (read_id, read_method, _) = peer.expect_request().await;
        assert_eq!(read_method, "thread/read");
        // Delay past the SHORT request_timeout (50ms) but well within the LONG
        // read_timeout (400ms) -- proves read_thread is governed by the latter.
        tokio::time::sleep(Duration::from_millis(150)).await;
        peer.respond(&read_id, json!({ "thread": { "id": "thread-1" } }));

        match task.await.unwrap() {
            Ok(value) => assert_eq!(value["thread"]["id"], json!("thread-1")),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resume_thread_honors_the_longer_read_timeout_not_the_request_timeout() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect_with_timeouts(
            transport,
            Duration::from_millis(50),
            Duration::from_millis(400),
        );
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move {
            c.resume_thread("thread-1", StartThreadParams::default())
                .await
        });

        let (init_id, init_method, _) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (resume_id, resume_method, _) = peer.expect_request().await;
        assert_eq!(resume_method, "thread/resume");
        // Same delay window as the read_thread test above.
        tokio::time::sleep(Duration::from_millis(150)).await;
        peer.respond(&resume_id, started_thread_result());

        match task.await.unwrap() {
            Ok(resumed) => assert_eq!(resumed.thread_id, "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e"),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn start_turn_is_unaffected_by_the_longer_read_timeout() {
        // Scope regression: turn/start (and every non-read RPC) must still be governed by
        // the SHORT request_timeout, not the read_timeout widened for thread/read + resume.
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect_with_timeouts(
            transport,
            Duration::from_millis(50),
            Duration::from_millis(400),
        );
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.start_turn(StartTurnParams::default()).await });

        let (init_id, init_method, _) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        // Never respond to turn/start -- it must time out at the SHORT request_timeout.
        let (_turn_id, turn_method, _) = peer.expect_request().await;
        assert_eq!(turn_method, "turn/start");

        match task.await.unwrap() {
            Err(CodexAppServerError::Timeout { method, timeout_ms }) => {
                assert_eq!(method, "turn/start");
                assert_eq!(timeout_ms, 50);
            }
            other => panic!("expected a Timeout at the short request_timeout, got {other:?}"),
        }
    }

    // ── thread/compact/start (AGENT-04, approval-respond Task 4) ─────────────

    #[tokio::test]
    async fn compact_thread_sends_thread_compact_start_with_only_the_thread_id() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.compact_thread("thread-1").await });

        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/compact/start");
        // 0.147.0 ThreadCompactStartParams: `{threadId}` ONLY -- pin the EXACT key set so
        // an `instructions` key (or anything else) can never sneak onto this schema.
        let obj = params.as_object().expect("params object");
        assert_eq!(obj.len(), 1, "params must carry ONLY threadId: {params}");
        assert_eq!(params["threadId"], json!("thread-1"));
        assert!(
            params.get("instructions").is_none(),
            "codex compact has NO instructions field (0.147.0), never one: {params}"
        );
        // The success response is `Record<string, never>` (an empty object).
        peer.respond(&id, json!({}));

        task.await.unwrap().expect("compact_thread succeeds");
    }

    #[tokio::test]
    async fn compact_thread_surfaces_an_rpc_error_with_the_method_name() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.compact_thread("thread-1").await });

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/compact/start");
        peer.respond_error(&id, -32600, "thread is mid-turn");

        match task.await.unwrap() {
            Err(CodexAppServerError::Rpc { method, error }) => {
                assert_eq!(method, "thread/compact/start");
                assert_eq!(error.code, -32600);
                assert_eq!(error.message, "thread is mid-turn");
            }
            other => panic!("expected an Rpc error, got {other:?}"),
        }
    }

    // ── thread/fork + thread/archive + thread/unarchive (AGENT-07, approval-respond Task 6) ──

    #[tokio::test]
    async fn fork_thread_serializes_without_exclude_turns_with_last_turn_id_and_returns_the_raw_result(
    ) {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move {
            c.fork_thread(ThreadForkParams {
                thread_id: "parent-1".to_string(),
                last_turn_id: Some("turn-3".to_string()),
                model: Some("gpt-5.3-codex-spark".to_string()),
                cwd: Some("/fork/cwd".to_string()),
                approval_policy: Some("on-request".to_string()),
                sandbox: Some("workspace-write".to_string()),
            })
            .await
        });

        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        // 0.147.0 `ThreadForkParams`: `{threadId, lastTurnId?, model?, cwd?,
        // approvalPolicy?, sandbox?}` — `excludeTurns` was REMOVED from that schema, so
        // it must NEVER be sent (the child keeps full history), and `lastTurnId` (the
        // per-turn fork knob) must pass through when the caller carried one.
        let obj = params.as_object().expect("params object");
        assert_eq!(
            obj.len(),
            6,
            "thread/fork params are exactly the 0.147.0 key set: {params}"
        );
        assert_eq!(params["threadId"], json!("parent-1"));
        assert_eq!(params["lastTurnId"], json!("turn-3"));
        assert_eq!(params["model"], json!("gpt-5.3-codex-spark"));
        assert_eq!(params["cwd"], json!("/fork/cwd"));
        assert_eq!(params["approvalPolicy"], json!("on-request"));
        assert_eq!(params["sandbox"], json!("workspace-write"));
        assert!(
            params.get("excludeTurns").is_none(),
            "0.147.0 removed excludeTurns from thread/fork — never send it: {params}"
        );
        peer.respond(&id, json!({ "thread": { "id": "child-1" } }));

        let result = task.await.unwrap().expect("fork_thread succeeds");
        assert_eq!(result["thread"]["id"], json!("child-1"));
    }

    #[tokio::test]
    async fn fork_thread_omits_absent_optional_keys() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move {
            c.fork_thread(ThreadForkParams {
                thread_id: "parent-2".to_string(),
                ..ThreadForkParams::default()
            })
            .await
        });

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let (_note, _) = peer.expect_notification().await;

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        let obj = params.as_object().expect("params object");
        assert_eq!(obj.len(), 1, "absent optionals omit their keys: {params}");
        assert_eq!(params["threadId"], json!("parent-2"));
        assert!(
            params.get("lastTurnId").is_none(),
            "no atTurnId → no lastTurnId (fork from the tip): {params}"
        );
        peer.respond(&id, json!({ "thread": { "id": "child-2" } }));

        let result = task.await.unwrap().expect("fork_thread succeeds");
        assert_eq!(result["thread"]["id"], json!("child-2"));
    }

    #[tokio::test]
    async fn archive_thread_and_unarchive_thread_send_their_method_names_with_only_thread_id() {
        for (call, expected_method) in [
            ("archive", "thread/archive"),
            ("unarchive", "thread/unarchive"),
        ] {
            let (transport, peer) = new_channel_transport();
            let (client, _notifs) = CodexAppServerClient::connect(transport);
            let client = Arc::new(client);

            let c = client.clone();
            let task = tokio::spawn(async move {
                match call {
                    "archive" => c.archive_thread("thread-9").await,
                    _ => c.unarchive_thread("thread-9").await,
                }
            });

            let (init_id, _m, _p) = peer.expect_request().await;
            peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
            let (_note, _) = peer.expect_notification().await;

            let (id, method, params) = peer.expect_request().await;
            assert_eq!(method, expected_method);
            let obj = params.as_object().expect("params object");
            assert_eq!(
                obj.len(),
                1,
                "{expected_method} params are `{{threadId}}` ONLY: {params}"
            );
            assert_eq!(params["threadId"], json!("thread-9"));
            // Archive/unarchive results are generic success payloads (parsed loosely).
            peer.respond(&id, json!({}));

            task.await.unwrap().expect("archive/unarchive succeeds");
        }
    }

    #[tokio::test]
    async fn fork_thread_surfaces_an_rpc_error_with_the_method_name() {
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move {
            c.fork_thread(ThreadForkParams {
                thread_id: "empty-parent".to_string(),
                ..ThreadForkParams::default()
            })
            .await
        });

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }));
        let (_note, _) = peer.expect_notification().await;

        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        // The PROBED empty-parent rejection (0.147.0 real binary).
        peer.respond_error(&id, -32600, "no rollout found for thread id");

        match task.await.unwrap() {
            Err(CodexAppServerError::Rpc { method, error }) => {
                assert_eq!(method, "thread/fork");
                assert_eq!(error.code, -32600);
                assert_eq!(error.message, "no rollout found for thread id");
            }
            other => panic!("expected an Rpc error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_thread_survives_past_the_production_default_request_timeout() {
        // Uses the REAL production defaults (connect(), not connect_with_timeouts) to prove
        // the wiring, not just the plumbing: DEFAULT_REQUEST_TIMEOUT_MS is 5s, so a reply
        // delayed past 5s but within SNAPSHOT_READ_TIMEOUT_MS (30s) must still succeed.
        // Bounded real sleep (~5.5s) -- acceptable per the task's own allowance.
        let (transport, peer) = new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let c = client.clone();
        let task = tokio::spawn(async move { c.read_thread("thread-big", true).await });

        let (init_id, init_method, _) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(&init_id, json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "unix", "platformOs": "linux" }));
        let (_note, _) = peer.expect_notification().await; // initialized

        let (read_id, read_method, _) = peer.expect_request().await;
        assert_eq!(read_method, "thread/read");
        tokio::time::sleep(Duration::from_millis(5_500)).await;
        peer.respond(&read_id, json!({ "thread": { "id": "thread-big" } }));

        match task.await.unwrap() {
            Ok(value) => assert_eq!(value["thread"]["id"], json!("thread-big")),
            other => panic!("expected Ok past the 5s default request_timeout, got {other:?}"),
        }
    }
}
