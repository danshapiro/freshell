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
}

/// The `thread/start` / `thread/resume` result the adapter reads (`client.ts:181-185`): the
/// stable thread id (a UUID) plus the echoed `reasoningEffort` (`protocol.ts:233`).
#[derive(Clone, Debug, PartialEq)]
pub struct StartedThread {
    pub thread_id: String,
    pub reasoning_effort: Option<String>,
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
    read_handle: tokio::task::JoinHandle<()>,
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        // Stop the background consumer when the client is dropped (no leaked task).
        self.read_handle.abort();
    }
}

impl CodexAppServerClient {
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
                "optOutNotificationMethods": ["thread/started"],
            },
        });
        let result = self
            .send_request("initialize", params, self.request_timeout)
            .await?;
        // client.ts:158 — the initialized notification follows a successful initialize.
        self.notify("initialized", None).await?;
        *guard = Some(result.clone());
        Ok(result)
    }

    /// `thread/start` (`client.ts:168-186`) — the stable-from-create codex thread.
    pub async fn start_thread(
        &self,
        params: StartThreadParams,
    ) -> Result<StartedThread, CodexAppServerError> {
        let mut wire = Map::new();
        insert_opt_str(&mut wire, "cwd", params.cwd);
        insert_opt_str(&mut wire, "model", params.model);
        insert_opt_str(&mut wire, "sandbox", params.sandbox);
        insert_opt_str(&mut wire, "approvalPolicy", params.approval_policy);
        // client.ts:172-173 — the client's fixed additions.
        wire.insert("experimentalRawEvents".to_string(), json!(false));
        wire.insert("persistExtendedHistory".to_string(), json!(true));

        let result = self.request("thread/start", Value::Object(wire)).await?;
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
        })
    }

    /// `turn/start` (`client.ts:424-431`; adapter send `adapter.ts:971-979`). **Forwards
    /// `effort` VERBATIM (DEV-0003)** — the value the caller supplies is inserted unchanged.
    pub async fn start_turn(
        &self,
        params: StartTurnParams,
    ) -> Result<StartedTurn, CodexAppServerError> {
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

    /// `turn/interrupt` (`client.ts:433-439`).
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

    fn started_thread_result() -> Value {
        json!({ "thread": { "id": "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e" }, "reasoningEffort": "none" })
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
