//! codex remote-proxy **WS relay server** — a faithful (scoped) port of
//! `server/coding-cli/codex-app-server/remote-proxy.ts` (`CodexRemoteProxy`, ~52 KB).
//!
//! DEV-0006 Slice 2 (`docs/plans/2026-07-19-dev0006-codex-launch-planning-spec.md` §5):
//! a loopback WS server the codex TUI connects to (`--remote <this ws_url>`); it dials a
//! real upstream app-server and relays frames bidirectionally, scanning them via the
//! Slice-1 pure extractors ([`crate::remote_proxy_envelope`],
//! [`crate::remote_proxy_side_effects`]) to surface durability candidates, turn/lifecycle
//! events, and `fs/changed` repair triggers, and rewriting the two `thread/fork` frames
//! (request: strip `turns`; response: normalize for the TUI). NOT wired into
//! `freshell-ws`/`freshell-server` in this slice — deliberately additive library code with
//! a typed `mpsc` event stream for a later slice (Slice 3/5) to consume.
//!
//! ## Scope decisions (flagged; see the task report for the full rationale)
//!
//! - **The `initial_capture` identity gate IS ported (DEV-0006 S5.c).** When
//!   `require_candidate_persistence` is true, client `turn/start`/`thread/fork` requests
//!   are HELD until the durability consumer calls
//!   [`CodexRemoteProxy::mark_candidate_persisted`]; capture failure/timeout answers the
//!   held frames with JSON-RPC `-32000` errors and emits
//!   [`RemoteProxyRepairTrigger::CandidateCaptureTimeout`]. The `fork_handoff` gate
//!   variant (and its `pause_candidate_capture`/`resume_candidate_capture` controls)
//!   remains UNPORTED — codexForkHandoff is fenced off (spec S5 out-of-scope list).
//! - **The proxy's own listener socket + the sidecar-process ownership reaper
//!   (`transport::reap_owned_codex_sidecars`) are different lifecycles.** `close()` here
//!   tears down the WS listener and all active client/upstream socket pairs (mirrors
//!   `remote-proxy.ts:178-204` exactly); it does NOT touch any child process — that's the
//!   Slice-3 launch-planner's sidecar handle, not this proxy's.
//! - **No protocol-level (tungstenite) frame-size cap is configured.** The app-level
//!   `max_raw_forward_bytes` guard (mirroring `maxRawForwardBytes`) is enforced in the hub
//!   after a message is fully buffered, matching legacy's own belt on top of `ws`'s
//!   `maxPayload` — see the module's tests for the exact rejection behavior.
//! - **Turn dedup state (`activeTurnKeys`/`completedTurnKeys`) is proxy-wide**, not
//!   per-connection — this matches `remote-proxy.ts` exactly (the fields live on the
//!   `CodexRemoteProxy` class, not `ProxyConnection`).
//! - **Numeric JSON-RPC ids used to correlate held candidate/fork ids are bridged via
//!   [`envelope_id_to_request_id`]**: a lossless string id, or a finite integer within
//!   `i64` range, converts to [`RequestId`]; anything else (fractional, too large, NaN)
//!   yields `None`, which means the frame simply won't match any pending id (a safe,
//!   fail-closed-by-omission fallback) rather than a panic or a lossy silent match. This
//!   mirrors the fact that `json-rpc-envelope.ts`'s `scanTopLevelId` and
//!   `json-rpc-side-effects.ts`'s `extractTopLevelId` are two independently-scanning
//!   functions with different id-precision semantics by design (see
//!   [`crate::remote_proxy_envelope`]'s module docs) — practical request ids (small
//!   sequential integers/strings) never hit this edge.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

use crate::protocol::RequestId;
use crate::remote_proxy_envelope::{
    scan_json_rpc_envelope, JsonRpcEnvelopeId, JsonRpcEnvelopeScanError, MAX_FULL_PARSE_BYTES,
    MAX_RAW_FORWARD_BYTES,
};
use crate::remote_proxy_side_effects::{
    extract_fork_response_candidate, extract_fs_changed_repair_trigger,
    extract_thread_lifecycle_event, extract_thread_start_response_candidate,
    extract_thread_started_notification_side_effects, extract_turn_notification_event,
    normalize_thread_fork_response_for_tui, rewrite_thread_fork_request_exclude_turns,
    ForkResponseOptions, RemoteProxyCandidate, ThreadLifecycleEvent, ThreadStartResponseOptions,
    ThreadStartedLifecycle, TurnEvent as SideEffectTurnEvent,
};

/// Upstream notification methods that get side-effect extraction
/// (`STATEFUL_NOTIFICATION_METHODS`, `remote-proxy.ts:103-110`).
const STATEFUL_NOTIFICATION_METHODS: &[&str] = &[
    "thread/started",
    "turn/started",
    "turn/completed",
    "fs/changed",
    "thread/closed",
    "thread/status/changed",
];

/// Server→client JSON-RPC REQUEST methods that block on a human. Sourced
/// from the codex 0.129.0 schema inventory
/// (test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:84-94)
/// and verified EXACT against the codex `ServerRequest` enum at both
/// 0.129.0 and the deployed 0.146.0.
const APPROVAL_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
];

/// Machine-serviced server→client requests — never human-attention.
/// (`attestation/generate` and `currentTime/read` are new at 0.146.0.)
/// Anything outside BOTH lists is debug-logged to catch future drift
/// (decision 6) — no bell, just logging.
const AUTOMATED_SERVER_REQUEST_METHODS: &[&str] = &[
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "currentTime/read",
];

/// Legacy approval methods carry `params.conversationId` instead of
/// `params.threadId` (codex-rs v1.rs:126-158).
const LEGACY_APPROVAL_REQUEST_METHODS: &[&str] = &["applyPatchApproval", "execCommandApproval"];

/// `MAX_COMPLETED_TURN_KEYS` (`remote-proxy.ts:95`).
const MAX_COMPLETED_TURN_KEYS: usize = 256;

/// `DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS` (`remote-proxy.ts:94`).
pub const CANDIDATE_CAPTURE_TIMEOUT_MS: u64 = 45_000;
/// `DEFAULT_REQUEST_HOLD_TIMEOUT_MS` (`remote-proxy.ts:93`) — armed on the FIRST held frame.
pub const IDENTITY_GATE_HOLD_TIMEOUT_MS: u64 = 5_000;
/// Legacy cap on held gate frames (`remote-proxy.ts` initial_capture hold queue).
pub const MAX_HELD_IDENTITY_GATE_FRAMES: usize = 32;

// ── public options / errors ─────────────────────────────────────────────────────────

/// Constructor options (`CodexRemoteProxyOptions`, `remote-proxy.ts:84-91`) — scoped to
/// what this slice ports (see module docs for what's deliberately absent).
#[derive(Clone, Debug)]
pub struct CodexRemoteProxyOptions {
    pub upstream_ws_url: String,
    /// `maxRawForwardBytes` (`remote-proxy.ts:90,141`); default [`MAX_RAW_FORWARD_BYTES`].
    pub max_raw_forward_bytes: usize,
    /// `requireCandidatePersistence` (`remote-proxy.ts:89,140`). Legacy defaults this to
    /// `true` AT THE PROXY; the Rust options carry NO default — the launch planner passes
    /// the plan's value explicitly on both the fresh and resume branches (S3 review
    /// note 2: no shadow default may stand in for the planner's intent). Consumed by the
    /// S5.c `initial_capture` identity gate (hold `turn/start`/`thread/fork` until
    /// [`CodexRemoteProxy::mark_candidate_persisted`]).
    pub require_candidate_persistence: bool,
    /// `DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS` override (`remote-proxy.ts:94,139`);
    /// default [`CANDIDATE_CAPTURE_TIMEOUT_MS`].
    pub candidate_capture_timeout_ms: u64,
    /// `DEFAULT_REQUEST_HOLD_TIMEOUT_MS` override (`remote-proxy.ts:93`);
    /// default [`IDENTITY_GATE_HOLD_TIMEOUT_MS`].
    pub identity_gate_hold_timeout_ms: u64,
}

impl CodexRemoteProxyOptions {
    pub fn new(upstream_ws_url: impl Into<String>, require_candidate_persistence: bool) -> Self {
        Self {
            upstream_ws_url: upstream_ws_url.into(),
            max_raw_forward_bytes: MAX_RAW_FORWARD_BYTES,
            require_candidate_persistence,
            candidate_capture_timeout_ms: CANDIDATE_CAPTURE_TIMEOUT_MS,
            identity_gate_hold_timeout_ms: IDENTITY_GATE_HOLD_TIMEOUT_MS,
        }
    }
}

/// Failure starting the proxy's loopback listener.
#[derive(Debug)]
pub enum ProxyStartError {
    Bind(String),
}

impl std::fmt::Display for ProxyStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyStartError::Bind(message) => {
                write!(
                    f,
                    "codex remote proxy failed to bind a loopback listener: {message}"
                )
            }
        }
    }
}

impl std::error::Error for ProxyStartError {}

// ── the consumer-facing event stream ────────────────────────────────────────────────

/// A turn lifecycle event's params, carrying the FULL upstream `params` object when the
/// frame was small enough for a full parse, or a reduced `{threadId, turnId?, status?}`
/// object when it wasn't (`emitTurnEvent`, `remote-proxy.ts:1089-1098`; the size-gated
/// dual path is `collectParsedUpstreamNotificationSideEffects` vs
/// `extractLargeUpstreamNotificationSideEffects`, `remote-proxy.ts:618-766`).
#[derive(Clone, Debug, PartialEq)]
pub struct TurnEventParams {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub params: Map<String, Value>,
}

/// One sniffed server→client approval REQUEST (a frame carrying BOTH `id` and `method`,
/// with the method in [`APPROVAL_REQUEST_METHODS`]) — the codex app-server is blocked on
/// a human until it resolves. Task 7 routes this into the hub's attention tracking.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRequestParams {
    /// Canonicalized request id (string form of the JSON-RPC id).
    pub request_id: String,
    pub method: String,
    /// Best-effort params.threadId — None for oversized/opaque frames.
    pub thread_id: Option<String>,
}

/// The lifecycle-LOSS subset of thread lifecycle notifications (`CodexThreadLifecycleLossEvent`,
/// `client.ts`, consumed at `remote-proxy.ts:669,677-681,745,751-756`): `thread/closed`
/// always; `thread/status/changed` only for the two loss-worthy statuses.
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadLifecycleLossEvent {
    ThreadClosed { thread_id: String },
    ThreadStatusChanged { thread_id: String, status: String },
}

/// `CodexRemoteProxyRepairTrigger` (`remote-proxy.ts:36-38`).
#[derive(Clone, Debug, PartialEq)]
pub enum RemoteProxyRepairTrigger {
    ProxyClose,
    ProxyError {
        message: String,
    },
    FsChanged {
        watch_id: String,
        changed_paths: Vec<String>,
    },
    /// `repair_trigger{kind:'candidate_capture_timeout'}` — the S5.c identity gate
    /// timed out waiting for the durability consumer to persist the candidate.
    CandidateCaptureTimeout,
}

/// The proxy's typed consumer event stream — the seam Slice 3/5 will subscribe to for
/// durability binding, activity tracking, and `terminal.meta.updated`. One
/// `mpsc::UnboundedReceiver<RemoteProxyEvent>` per proxy instance, returned by
/// [`CodexRemoteProxy::start`]. Mirrors the six `on*` handler sets in
/// `remote-proxy.ts:126-131` (candidate/turnStarted/turnCompleted/repairTrigger/
/// threadLifecycle/lifecycleLoss) collapsed into one ordered stream rather than six
/// separate closure-registration APIs — an mpsc is the idiomatic Rust shape for "a set of
/// typed things happened, in order," and one channel preserves the cross-category
/// ordering the six-Set-of-closures design in TS didn't guarantee anyway.
#[derive(Clone, Debug, PartialEq)]
pub enum RemoteProxyEvent {
    Candidate(RemoteProxyCandidate),
    ThreadStarted(ThreadStartedLifecycle),
    ThreadLifecycle(ThreadLifecycleEvent),
    ThreadLifecycleLoss(ThreadLifecycleLossEvent),
    TurnStarted(TurnEventParams),
    TurnCompleted(TurnEventParams),
    RepairTrigger(RemoteProxyRepairTrigger),
    /// A server→client approval request was sniffed (decision 5) — the app-server is
    /// blocked on a human. The frame itself is relayed verbatim regardless.
    ApprovalRequested(ApprovalRequestParams),
    /// A previously-sniffed approval resolved: a client `{id, result}` OR `{id, error}`
    /// response (decision 5a), an upstream `serverRequest/resolved` notification
    /// (decision 5c), or connection teardown draining the pending set (decision 5b).
    ApprovalResolved {
        request_id: String,
    },
}

// ── the proxy handle ─────────────────────────────────────────────────────────────────

/// A running codex remote proxy. Own it for the lifetime of the codex terminal pane it
/// serves; call [`CodexRemoteProxy::close`] to tear it down.
pub struct CodexRemoteProxy {
    ws_url: String,
    hub_tx: mpsc::UnboundedSender<HubMsg>,
    accept_task: JoinHandle<()>,
    hub_task: JoinHandle<()>,
    require_candidate_persistence: bool,
}

impl CodexRemoteProxy {
    /// Bind an ephemeral loopback listener and start relaying (`start()`,
    /// `remote-proxy.ts:152-176`). Never binds anything but `127.0.0.1:0` — the OS assigns
    /// the ephemeral port, so this can never collide with a fixed port like 3001/3002.
    pub async fn start(
        options: CodexRemoteProxyOptions,
    ) -> Result<(Self, mpsc::UnboundedReceiver<RemoteProxyEvent>), ProxyStartError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| ProxyStartError::Bind(e.to_string()))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ProxyStartError::Bind(e.to_string()))?;
        let ws_url = format!("ws://{}:{}", local_addr.ip(), local_addr.port());

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (hub_tx, hub_rx) = mpsc::unbounded_channel();

        let hub_task = tokio::spawn(run_hub(
            hub_rx,
            events_tx,
            options.max_raw_forward_bytes,
            options.require_candidate_persistence,
            options.identity_gate_hold_timeout_ms,
            hub_tx.clone(),
        ));

        // Arm the candidate-capture timer (`DEFAULT_CANDIDATE_CAPTURE_TIMEOUT_MS`,
        // `remote-proxy.ts:94`): if nothing persists (or fails) the candidate first,
        // the gate fails with `candidate_capture_timeout`.
        if options.require_candidate_persistence {
            let timer_tx = hub_tx.clone();
            let timeout_ms = options.candidate_capture_timeout_ms;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                let _ = timer_tx.send(HubMsg::CandidateCaptureTimedOut);
            });
        }

        let upstream_ws_url = options.upstream_ws_url;
        let accept_hub_tx = hub_tx.clone();
        let accept_task = tokio::spawn(async move {
            let mut next_conn_id: u64 = 0;
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let conn_id = next_conn_id;
                next_conn_id += 1;
                let upstream_ws_url = upstream_ws_url.clone();
                let hub_tx = accept_hub_tx.clone();
                tokio::spawn(async move {
                    handle_client_connection(conn_id, stream, upstream_ws_url, hub_tx).await;
                });
            }
        });

        Ok((
            Self {
                ws_url,
                hub_tx,
                accept_task,
                hub_task,
                require_candidate_persistence: options.require_candidate_persistence,
            },
            events_rx,
        ))
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// The `requireCandidatePersistence` value this proxy was constructed with —
    /// recorded for the S5 identity gate; asserted by the launch-planner tests so the
    /// fresh(true)/resume(false) knob can never drift behind a hidden default.
    pub fn require_candidate_persistence(&self) -> bool {
        self.require_candidate_persistence
    }

    /// S5.c release: the durability consumer persisted the candidate
    /// (`markCandidatePersisted`, `remote-proxy.ts:206-256`). Fire-and-forget.
    pub fn mark_candidate_persisted(&self) {
        let _ = self.hub_tx.send(HubMsg::MarkCandidatePersisted);
    }

    /// S5.c failure: the candidate was refused (identity guards) — reject held
    /// frames and close (`failCandidateCapture`).
    pub fn fail_candidate_capture(&self, message: &str) {
        let _ = self.hub_tx.send(HubMsg::FailCandidateCapture {
            message: message.to_string(),
        });
    }

    /// Tear down the listener and every active client/upstream socket pair
    /// (`close()`, `remote-proxy.ts:178-204`), draining the identity gate first:
    /// any still-held gated frames are answered with -32000 errors on shutdown.
    pub async fn close(self) {
        self.accept_task.abort();
        let (done_tx, done_rx) = oneshot::channel();
        let _ = self.hub_tx.send(HubMsg::Shutdown { done: done_tx });
        let _ = done_rx.await;
        let _ = self.hub_task.await;
    }
}

// ── internal wire types between reader/writer tasks and the hub ────────────────────

struct OutFrame {
    data: Vec<u8>,
    binary: bool,
}

enum WriterMsg {
    Frame(OutFrame),
    Close,
}

enum HubMsg {
    ClientConnected {
        conn_id: u64,
        tx: mpsc::UnboundedSender<WriterMsg>,
    },
    UpstreamConnected {
        conn_id: u64,
        tx: mpsc::UnboundedSender<WriterMsg>,
    },
    UpstreamDialFailed {
        conn_id: u64,
    },
    ClientFrame {
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
    },
    UpstreamFrame {
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
    },
    ClientClosed {
        conn_id: u64,
    },
    ClientErrored {
        conn_id: u64,
    },
    UpstreamClosed {
        conn_id: u64,
    },
    UpstreamErrored {
        conn_id: u64,
    },
    MarkCandidatePersisted,
    FailCandidateCapture {
        message: String,
    },
    CandidateCaptureTimedOut,
    IdentityGateHoldTimedOut,
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

// ── connection-supervisor task (per accepted TUI connection) ───────────────────────

/// Accepts one TUI connection, dials one upstream connection for it (mirrors
/// `handleClientConnection`, `remote-proxy.ts:288-369`: each accepted client gets its OWN
/// upstream socket, not a shared one), and pumps raw frames to the hub.
async fn handle_client_connection(
    conn_id: u64,
    stream: TcpStream,
    upstream_ws_url: String,
    hub_tx: mpsc::UnboundedSender<HubMsg>,
) {
    let ws = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut client_sink, mut client_stream) = ws.split();

    let (client_writer_tx, mut client_writer_rx) = mpsc::unbounded_channel::<WriterMsg>();
    let client_writer_task = tokio::spawn(async move {
        while let Some(msg) = client_writer_rx.recv().await {
            match msg {
                WriterMsg::Frame(frame) => {
                    if client_sink.send(to_ws_message(frame)).await.is_err() {
                        break;
                    }
                }
                WriterMsg::Close => {
                    let _ = client_sink.close().await;
                    break;
                }
            }
        }
    });

    if hub_tx
        .send(HubMsg::ClientConnected {
            conn_id,
            tx: client_writer_tx,
        })
        .is_err()
    {
        client_writer_task.abort();
        return;
    }

    // Dial upstream concurrently — mirrors `new WebSocket(this.upstreamWsUrl)` firing
    // immediately on accept without blocking further client reads.
    let dial_hub_tx = hub_tx.clone();
    tokio::spawn(dial_upstream(conn_id, upstream_ws_url, dial_hub_tx));

    loop {
        match client_stream.next().await {
            Some(Ok(Message::Text(text))) => {
                if hub_tx
                    .send(HubMsg::ClientFrame {
                        conn_id,
                        data: text.into_bytes(),
                        binary: false,
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(Message::Binary(bytes))) => {
                if hub_tx
                    .send(HubMsg::ClientFrame {
                        conn_id,
                        data: bytes,
                        binary: true,
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(_)) => continue, // ping/pong/close frames: transport noise
            Some(Err(_)) => {
                let _ = hub_tx.send(HubMsg::ClientErrored { conn_id });
                break;
            }
            None => {
                let _ = hub_tx.send(HubMsg::ClientClosed { conn_id });
                break;
            }
        }
    }
    client_writer_task.abort();
}

async fn dial_upstream(
    conn_id: u64,
    upstream_ws_url: String,
    hub_tx: mpsc::UnboundedSender<HubMsg>,
) {
    let (ws, _) = match connect_async(&upstream_ws_url).await {
        Ok(pair) => pair,
        Err(_) => {
            let _ = hub_tx.send(HubMsg::UpstreamDialFailed { conn_id });
            return;
        }
    };
    let (mut upstream_sink, mut upstream_stream) = ws.split();

    let (upstream_writer_tx, mut upstream_writer_rx) = mpsc::unbounded_channel::<WriterMsg>();
    tokio::spawn(async move {
        while let Some(msg) = upstream_writer_rx.recv().await {
            match msg {
                WriterMsg::Frame(frame) => {
                    if upstream_sink.send(to_ws_message(frame)).await.is_err() {
                        break;
                    }
                }
                WriterMsg::Close => {
                    let _ = upstream_sink.close().await;
                    break;
                }
            }
        }
    });

    if hub_tx
        .send(HubMsg::UpstreamConnected {
            conn_id,
            tx: upstream_writer_tx,
        })
        .is_err()
    {
        return;
    }

    loop {
        match upstream_stream.next().await {
            Some(Ok(Message::Text(text))) => {
                if hub_tx
                    .send(HubMsg::UpstreamFrame {
                        conn_id,
                        data: text.into_bytes(),
                        binary: false,
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(Message::Binary(bytes))) => {
                if hub_tx
                    .send(HubMsg::UpstreamFrame {
                        conn_id,
                        data: bytes,
                        binary: true,
                    })
                    .is_err()
                {
                    break;
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) => {
                let _ = hub_tx.send(HubMsg::UpstreamErrored { conn_id });
                break;
            }
            None => {
                let _ = hub_tx.send(HubMsg::UpstreamClosed { conn_id });
                break;
            }
        }
    }
}

fn to_ws_message(frame: OutFrame) -> Message {
    if frame.binary {
        Message::Binary(frame.data)
    } else {
        // Every producer of an OutFrame (the raw client/upstream bytes, or a
        // rewritten/normalized/error/success frame we constructed) is valid UTF-8 JSON.
        Message::Text(String::from_utf8_lossy(&frame.data).into_owned())
    }
}

// ── the hub: single-task owner of all shared relay/dedup state ─────────────────────

struct ConnState {
    client_tx: Option<mpsc::UnboundedSender<WriterMsg>>,
    upstream_tx: Option<mpsc::UnboundedSender<WriterMsg>>,
    /// Frames queued because the upstream dial hasn't completed yet — mirrors
    /// `sendIfOpen`'s `CONNECTING` branch (`remote-proxy.ts:1173-1181`), which registers a
    /// one-time `'open'` listener PER frame; since listeners for the same event fire in
    /// registration order, that preserves relative ordering exactly like this FIFO queue
    /// does, drained the instant [`HubMsg::UpstreamConnected`] arrives.
    pending_to_upstream: VecDeque<OutFrame>,
    pending_methods: HashMap<RequestId, String>,
    pending_fork_requests: HashMap<RequestId, Option<String>>,
    /// Sniffed server→client approval requests still awaiting a resolution (decision 5).
    /// Keyed on the SERVER's id space (never consulted for our own client requests);
    /// drained with `ApprovalResolved` emissions on connection teardown (decision 5b).
    pending_server_approvals: HashSet<RequestId>,
}

impl ConnState {
    fn new() -> Self {
        Self {
            client_tx: None,
            upstream_tx: None,
            pending_to_upstream: VecDeque::new(),
            pending_methods: HashMap::new(),
            pending_fork_requests: HashMap::new(),
            pending_server_approvals: HashSet::new(),
        }
    }
}

struct HeldGateFrame {
    conn_id: u64,
    data: Vec<u8>,
    binary: bool,
}

/// The ported `initial_capture` identity gate (`remote-proxy.ts:67-96,422-425`).
/// The fork_handoff gate variant is NOT ported (codexForkHandoff is fenced off,
/// spec S5 out-of-scope list) — this gate has exactly one reason.
enum IdentityGate {
    /// require_candidate_persistence=false, or the candidate was persisted.
    Open,
    /// Fresh managed launch awaiting candidate persistence. `held_bytes` is
    /// the cumulative size of the held frames (legacy `heldBytes`, ledger A28).
    Holding {
        held: Vec<HeldGateFrame>,
        held_bytes: usize,
        hold_timer_armed: bool,
    },
    /// Capture failed or timed out: gated methods are rejected outright.
    Failed,
}

struct Hub {
    connections: HashMap<u64, ConnState>,
    max_raw_forward_bytes: usize,
    active_turn_keys: HashSet<String>,
    completed_turn_keys_set: HashSet<String>,
    completed_turn_keys_order: VecDeque<String>,
    events_tx: mpsc::UnboundedSender<RemoteProxyEvent>,
    identity_gate: IdentityGate,
    /// The hub's own inbox — used to arm the hold timer on the FIRST held frame.
    hub_tx: mpsc::UnboundedSender<HubMsg>,
    hold_timeout_ms: u64,
}

/// The FULL upstream side-effect bundle for one notification frame — mirrors
/// `UpstreamSideEffects` (`remote-proxy.ts:48-56`).
#[derive(Default)]
struct Effects {
    candidates: Vec<RemoteProxyCandidate>,
    thread_started: Vec<ThreadStartedLifecycle>,
    turn_started: Vec<TurnEventParams>,
    turn_completed: Vec<TurnEventParams>,
    repair_triggers: Vec<RemoteProxyRepairTrigger>,
    lifecycle_events: Vec<ThreadLifecycleEvent>,
    lifecycle_loss_events: Vec<ThreadLifecycleLossEvent>,
}

async fn run_hub(
    mut rx: mpsc::UnboundedReceiver<HubMsg>,
    events_tx: mpsc::UnboundedSender<RemoteProxyEvent>,
    max_raw_forward_bytes: usize,
    require_candidate_persistence: bool,
    hold_timeout_ms: u64,
    hub_tx: mpsc::UnboundedSender<HubMsg>,
) {
    let mut hub = Hub {
        connections: HashMap::new(),
        max_raw_forward_bytes,
        active_turn_keys: HashSet::new(),
        completed_turn_keys_set: HashSet::new(),
        completed_turn_keys_order: VecDeque::new(),
        events_tx,
        identity_gate: if require_candidate_persistence {
            IdentityGate::Holding {
                held: Vec::new(),
                held_bytes: 0,
                hold_timer_armed: false,
            }
        } else {
            IdentityGate::Open
        },
        hub_tx,
        hold_timeout_ms,
    };

    while let Some(msg) = rx.recv().await {
        match msg {
            HubMsg::ClientConnected { conn_id, tx } => {
                let conn = hub
                    .connections
                    .entry(conn_id)
                    .or_insert_with(ConnState::new);
                conn.client_tx = Some(tx);
            }
            HubMsg::UpstreamConnected { conn_id, tx } => {
                if let Some(conn) = hub.connections.get_mut(&conn_id) {
                    for frame in conn.pending_to_upstream.drain(..) {
                        let _ = tx.send(WriterMsg::Frame(frame));
                    }
                    conn.upstream_tx = Some(tx);
                }
            }
            HubMsg::UpstreamDialFailed { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(
                    RemoteProxyRepairTrigger::ProxyError {
                        message: "Codex remote proxy could not connect to the upstream app-server."
                            .to_string(),
                    },
                ));
                hub.close_connection(conn_id);
            }
            HubMsg::ClientFrame {
                conn_id,
                data,
                binary,
            } => {
                hub.handle_client_frame(conn_id, data, binary);
            }
            HubMsg::UpstreamFrame {
                conn_id,
                data,
                binary,
            } => {
                hub.handle_upstream_frame(conn_id, data, binary);
            }
            HubMsg::ClientClosed { conn_id } => {
                hub.close_connection(conn_id);
            }
            HubMsg::ClientErrored { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(
                    RemoteProxyRepairTrigger::ProxyError {
                        message: "Codex remote proxy client connection errored.".to_string(),
                    },
                ));
                hub.close_connection(conn_id);
            }
            HubMsg::UpstreamClosed { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(
                    RemoteProxyRepairTrigger::ProxyClose,
                ));
                hub.close_connection(conn_id);
            }
            HubMsg::UpstreamErrored { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(
                    RemoteProxyRepairTrigger::ProxyError {
                        message: "Codex remote proxy upstream connection errored.".to_string(),
                    },
                ));
                hub.close_connection(conn_id);
            }
            HubMsg::MarkCandidatePersisted => {
                hub.release_identity_gate();
            }
            HubMsg::FailCandidateCapture { message } => {
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    let msg = format!("Codex candidate capture failed: {message}");
                    // A28: any initial-capture failure (identity-guard refusal
                    // included) fires candidate_capture_timeout, not proxy_error.
                    hub.fail_identity_gate(
                        &msg,
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
            }
            HubMsg::CandidateCaptureTimedOut => {
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    hub.fail_identity_gate(
                        "Codex candidate capture timed out before the candidate was persisted.",
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
            }
            HubMsg::IdentityGateHoldTimedOut => {
                if let IdentityGate::Holding { held, .. } = &hub.identity_gate {
                    if !held.is_empty() {
                        hub.fail_identity_gate(
                            "Codex identity gate held a request past the hold timeout.",
                            Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                        );
                    }
                }
            }
            HubMsg::Shutdown { done } => {
                if matches!(hub.identity_gate, IdentityGate::Holding { .. }) {
                    hub.fail_identity_gate(
                        "Codex remote proxy closed while identity-gated requests were held.",
                        None,
                    );
                }
                let drained: Vec<ConnState> = hub.connections.drain().map(|(_, c)| c).collect();
                for conn in drained {
                    // Decision 5b: shutdown is a teardown too — drain pending approvals.
                    for req_id in conn.pending_server_approvals {
                        hub.emit(RemoteProxyEvent::ApprovalResolved {
                            request_id: request_id_to_string(&req_id),
                        });
                    }
                    if let Some(tx) = conn.client_tx {
                        let _ = tx.send(WriterMsg::Close);
                    }
                    if let Some(tx) = conn.upstream_tx {
                        let _ = tx.send(WriterMsg::Close);
                    }
                }
                let _ = done.send(());
                return;
            }
        }
    }
}

impl Hub {
    fn emit(&self, event: RemoteProxyEvent) {
        let _ = self.events_tx.send(event);
    }

    fn close_connection(&mut self, conn_id: u64) {
        if let Some(conn) = self.connections.remove(&conn_id) {
            // Decision 5b: teardown/restart drains ALL pending approvals. A restarted
            // app-server's per-process id counter starts at 0 again, so stale pending
            // ids would collide with the next incarnation's fresh requests — resolve
            // them now rather than letting a tracker stay paused forever.
            for req_id in conn.pending_server_approvals {
                self.emit(RemoteProxyEvent::ApprovalResolved {
                    request_id: request_id_to_string(&req_id),
                });
            }
            if let Some(tx) = conn.client_tx {
                let _ = tx.send(WriterMsg::Close);
            }
            if let Some(tx) = conn.upstream_tx {
                let _ = tx.send(WriterMsg::Close);
            }
        }
    }

    fn send_to_client(&self, conn_id: u64, data: Vec<u8>, binary: bool) {
        if let Some(conn) = self.connections.get(&conn_id) {
            if let Some(tx) = &conn.client_tx {
                let _ = tx.send(WriterMsg::Frame(OutFrame { data, binary }));
            }
        }
    }

    fn send_to_upstream(&mut self, conn_id: u64, data: Vec<u8>, binary: bool) {
        let Some(conn) = self.connections.get_mut(&conn_id) else {
            return;
        };
        match &conn.upstream_tx {
            Some(tx) => {
                let _ = tx.send(WriterMsg::Frame(OutFrame { data, binary }));
            }
            // Upstream dial hasn't completed yet — queue it (see `pending_to_upstream`'s
            // docs) rather than dropping it.
            None => conn
                .pending_to_upstream
                .push_back(OutFrame { data, binary }),
        }
    }

    fn send_json_rpc_error_to_client(
        &self,
        conn_id: u64,
        id: Option<&JsonRpcEnvelopeId>,
        message: &str,
    ) {
        let mut obj = Map::new();
        obj.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
        if let Some(id) = id {
            obj.insert("id".to_string(), envelope_id_to_json(id));
        }
        obj.insert(
            "error".to_string(),
            serde_json::json!({"code": -32000, "message": message}),
        );
        let bytes = serde_json::to_vec(&Value::Object(obj)).unwrap_or_default();
        self.send_to_client(conn_id, bytes, false);
    }

    fn release_identity_gate(&mut self) {
        let gate = std::mem::replace(&mut self.identity_gate, IdentityGate::Open);
        if let IdentityGate::Holding { held, .. } = gate {
            // Replay in order through the normal path (thread/fork frames get
            // their exclude-turns rewrite; turn/start forwards).
            for frame in held {
                self.handle_client_frame(frame.conn_id, frame.data, frame.binary);
            }
        }
    }

    /// `failIdentityGate(..., closeAllConnections: true)` (`remote-proxy.ts:948-980`):
    /// answer every held frame with a -32000 error, mark the gate failed, and
    /// close every socket pair.
    fn fail_identity_gate(&mut self, message: &str, trigger: Option<RemoteProxyRepairTrigger>) {
        let gate = std::mem::replace(&mut self.identity_gate, IdentityGate::Failed);
        if let IdentityGate::Holding { held, .. } = gate {
            for frame in held {
                let id = scan_json_rpc_envelope(&frame.data).ok().and_then(|e| e.id);
                self.send_json_rpc_error_to_client(frame.conn_id, id.as_ref(), message);
            }
        }
        if let Some(trigger) = trigger {
            self.emit(RemoteProxyEvent::RepairTrigger(trigger));
        }
        let conn_ids: Vec<u64> = self.connections.keys().copied().collect();
        for conn_id in conn_ids {
            self.close_connection(conn_id);
        }
    }

    fn send_json_rpc_success_to_client(&self, conn_id: u64, id: &JsonRpcEnvelopeId) {
        let obj = serde_json::json!({"id": envelope_id_to_json(id), "result": {}});
        let bytes = serde_json::to_vec(&obj).unwrap_or_default();
        self.send_to_client(conn_id, bytes, false);
    }

    // ── client -> upstream (`handleClientMessage`, `remote-proxy.ts:371-455`) ───────

    fn handle_client_frame(&mut self, conn_id: u64, data: Vec<u8>, binary: bool) {
        if data.len() > self.max_raw_forward_bytes {
            let id = if data.len() <= MAX_FULL_PARSE_BYTES {
                scan_json_rpc_envelope(&data).ok().and_then(|e| e.id)
            } else {
                None
            };
            self.send_json_rpc_error_to_client(
                conn_id,
                id.as_ref(),
                "Codex remote proxy rejected a JSON-RPC frame because it is too large.",
            );
            self.emit(RemoteProxyEvent::RepairTrigger(
                RemoteProxyRepairTrigger::ProxyError {
                    message:
                        "Codex remote proxy rejected a JSON-RPC frame because it is too large."
                            .to_string(),
                },
            ));
            self.close_connection(conn_id);
            return;
        }

        let envelope = match scan_json_rpc_envelope(&data) {
            Ok(envelope) => envelope,
            Err(reason) => {
                self.send_json_rpc_error_to_client(
                    conn_id,
                    None,
                    &client_envelope_failure_message(reason),
                );
                self.emit(RemoteProxyEvent::RepairTrigger(
                    RemoteProxyRepairTrigger::ProxyError {
                        message: client_envelope_failure_message(reason),
                    },
                ));
                self.close_connection(conn_id);
                return;
            }
        };

        let method = envelope.method.clone();
        let id = envelope.id.clone();

        // S5.c identity gate (`remote-proxy.ts:422-425`): on a fresh managed
        // launch, hold turn/start + thread/fork until the durability consumer
        // persists the candidate. Everything else flows so the pane boots.
        if matches!(method.as_deref(), Some("turn/start") | Some("thread/fork")) {
            let mut frame_held = false;
            match &mut self.identity_gate {
                IdentityGate::Holding {
                    hold_timer_armed, ..
                } => {
                    if !*hold_timer_armed {
                        *hold_timer_armed = true;
                        let timer_tx = self.hub_tx.clone();
                        let timeout_ms = self.hold_timeout_ms;
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                            let _ = timer_tx.send(HubMsg::IdentityGateHoldTimedOut);
                        });
                    }
                    frame_held = true;
                }
                IdentityGate::Failed => {
                    self.send_json_rpc_error_to_client(
                        conn_id,
                        id.as_ref(),
                        "Codex candidate capture failed; identity-gated request rejected.",
                    );
                    return;
                }
                IdentityGate::Open => {}
            }
            // (`frame_held`/`capture_failure` keep the `fail_identity_gate(&mut self, ...)`
            // call OUTSIDE the `IdentityGate::Holding` borrow; `data` is moved into the
            // hold queue only on this unconditionally-returning branch.)
            if frame_held {
                let mut capture_failure: Option<&'static str> = None;
                if let IdentityGate::Holding {
                    held, held_bytes, ..
                } = &mut self.identity_gate
                {
                    // Legacy parity (ledger A28): push FIRST, then evaluate the
                    // caps — queue overflow and the cumulative held-bytes cap
                    // are capture FAILURES (legacy pushes the 33rd frame and
                    // THEN fails the gate), never silent per-frame refusals.
                    *held_bytes = held_bytes.saturating_add(data.len());
                    held.push(HeldGateFrame {
                        conn_id,
                        data,
                        binary,
                    });
                    if held.len() > MAX_HELD_IDENTITY_GATE_FRAMES {
                        capture_failure =
                            Some("Codex remote proxy identity gate hold queue overflowed.");
                    } else if *held_bytes > self.max_raw_forward_bytes {
                        capture_failure = Some(
                            "Codex remote proxy identity gate held bytes exceeded the raw-forward cap.",
                        );
                    }
                }
                if let Some(message) = capture_failure {
                    // A28: ANY initial-capture failure (overflow/refusal
                    // included) fires candidate_capture_timeout.
                    self.fail_identity_gate(
                        message,
                        Some(RemoteProxyRepairTrigger::CandidateCaptureTimeout),
                    );
                }
                return;
            }
        }

        if method.as_deref() == Some("thread/fork") {
            self.handle_thread_fork_request(conn_id, data, binary, id);
            return;
        }

        if method.as_deref() == Some("turn/interrupt") && data.len() <= MAX_FULL_PARSE_BYTES {
            if let (Ok(parsed), Some(id)) = (serde_json::from_slice::<Value>(&data), id.as_ref()) {
                if self.completed_turn_interrupt(&parsed).is_some() {
                    self.send_json_rpc_success_to_client(conn_id, id);
                    return;
                }
            }
        }

        self.forward_client_frame(conn_id, data, binary, id, method);
    }

    fn forward_client_frame(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        id: Option<JsonRpcEnvelopeId>,
        method: Option<String>,
    ) {
        if let Some(req_id) = id.as_ref().and_then(envelope_id_to_request_id) {
            match method {
                Some(method) => {
                    if let Some(conn) = self.connections.get_mut(&conn_id) {
                        conn.pending_methods.insert(req_id, method);
                    }
                }
                None => {
                    // A response frame: {id, result} OR {id, error} — BOTH resolve a
                    // pending server approval (decision 5a; codex handles errors via
                    // process_error). The `method`-absence check is MANDATORY
                    // (decision 5d): a client REQUEST whose id numerically collides
                    // with a pending server approval must not resolve it, so this arm
                    // only ever sees genuine responses.
                    let resolved = self
                        .connections
                        .get_mut(&conn_id)
                        .is_some_and(|conn| conn.pending_server_approvals.remove(&req_id));
                    if resolved {
                        self.emit(RemoteProxyEvent::ApprovalResolved {
                            request_id: request_id_to_string(&req_id),
                        });
                    }
                }
            }
        }
        self.send_to_upstream(conn_id, data, binary);
    }

    /// `handleThreadForkRequest` (`remote-proxy.ts:791-829`), sans the identity-gate
    /// nested-fork rejection (that check lives entirely inside the deferred gate).
    fn handle_thread_fork_request(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        id: Option<JsonRpcEnvelopeId>,
    ) {
        let rewritten = match rewrite_thread_fork_request_exclude_turns(&data) {
            Ok(rewritten) => rewritten,
            Err(reason) => {
                self.send_json_rpc_error_to_client(
                    conn_id,
                    id.as_ref(),
                    &format!("Codex remote proxy could not safely rewrite thread/fork request: {reason:?}."),
                );
                return;
            }
        };

        if rewritten.len() > self.max_raw_forward_bytes {
            self.send_json_rpc_error_to_client(
                conn_id,
                id.as_ref(),
                "Codex remote proxy rejected a rewritten thread/fork request because it is too large.",
            );
            self.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                message: "Codex remote proxy rejected a rewritten thread/fork request because it is too large.".to_string(),
            }));
            self.close_connection(conn_id);
            return;
        }

        if let Some(req_id) = id.as_ref().and_then(envelope_id_to_request_id) {
            let parent_thread_id = extract_thread_fork_parent_thread_id(&data);
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                conn.pending_fork_requests.insert(req_id, parent_thread_id);
            }
        }
        self.forward_client_frame(
            conn_id,
            rewritten,
            binary,
            id,
            Some("thread/fork".to_string()),
        );
    }

    // ── upstream -> client (`handleUpstreamMessage`, `remote-proxy.ts:457-511`) ─────

    fn handle_upstream_frame(&mut self, conn_id: u64, data: Vec<u8>, binary: bool) {
        if data.len() > self.max_raw_forward_bytes {
            self.fail_unsafe_upstream_frame(conn_id, None, "raw_forward_cap_exceeded");
            return;
        }

        let envelope = match scan_json_rpc_envelope(&data) {
            Ok(envelope) => envelope,
            Err(reason) => {
                self.fail_unsafe_upstream_frame(conn_id, None, &format!("{reason:?}"));
                return;
            }
        };

        if let Some(id) = envelope.id.clone() {
            if let Some(method) = envelope.method.as_deref() {
                // id + method ⇒ a server→client REQUEST (our own responses never
                // reach this path). Never consult pending_methods for these — the
                // server's id space is not ours.
                if APPROVAL_REQUEST_METHODS.contains(&method) {
                    if let Some(req_id) = envelope_id_to_request_id(&id) {
                        // v2 methods carry params.threadId; legacy methods carry
                        // params.conversationId (decision 7, codex-rs v1.rs:126-158).
                        let thread_pointer = if LEGACY_APPROVAL_REQUEST_METHODS.contains(&method) {
                            "/params/conversationId"
                        } else {
                            "/params/threadId"
                        };
                        let thread_id = (data.len() <= MAX_FULL_PARSE_BYTES)
                            .then(|| serde_json::from_slice::<Value>(&data).ok())
                            .flatten()
                            .and_then(|v| {
                                v.pointer(thread_pointer)
                                    .and_then(|t| t.as_str())
                                    .map(str::to_string)
                            });
                        if let Some(conn) = self.connections.get_mut(&conn_id) {
                            conn.pending_server_approvals.insert(req_id);
                        }
                        self.emit(RemoteProxyEvent::ApprovalRequested(ApprovalRequestParams {
                            request_id: envelope_id_to_string(&id),
                            method: method.to_string(),
                            thread_id,
                        }));
                    }
                } else if !AUTOMATED_SERVER_REQUEST_METHODS.contains(&method) {
                    // Decision 6: the method set is version-fluid — surface drift.
                    tracing::debug!(
                        method,
                        "unrecognized codex server->client request method (not treated as an approval)"
                    );
                }
                // The proxy observes, never consumes: every server→client request
                // relays verbatim, approval or not.
                self.send_to_client(conn_id, data, binary);
                return;
            }

            let req_id = envelope_id_to_request_id(&id);
            let (method, fork_request) = match self.connections.get_mut(&conn_id) {
                Some(conn) => {
                    let method = req_id
                        .as_ref()
                        .and_then(|rid| conn.pending_methods.remove(rid));
                    let fork_request = req_id
                        .as_ref()
                        .and_then(|rid| conn.pending_fork_requests.get(rid).cloned());
                    (method, fork_request)
                }
                None => (None, None),
            };

            if method.as_deref() == Some("thread/start") {
                self.handle_thread_start_response(conn_id, data, binary, req_id);
                return;
            }
            if method.as_deref() == Some("thread/fork") || fork_request.is_some() {
                self.handle_thread_fork_response(
                    conn_id,
                    data,
                    binary,
                    req_id,
                    fork_request.flatten(),
                );
                return;
            }
            self.send_to_client(conn_id, data, binary);
            return;
        }

        if let Some(method) = envelope.method.as_deref() {
            if method == "serverRequest/resolved" {
                // Decision 5c: the app-server resolved its own request (fields
                // {thread_id, request_id} under camelCase serde rename — codex
                // v2/notification.rs:53-56 @0.146.0). Resolve the pending approval;
                // relay the notification verbatim regardless.
                self.handle_server_request_resolved_notification(&data);
                self.send_to_client(conn_id, data, binary);
                return;
            }
            if STATEFUL_NOTIFICATION_METHODS.contains(&method) {
                self.handle_stateful_upstream_notification(conn_id, data, binary, method);
                return;
            }
        }
        self.send_to_client(conn_id, data, binary);
    }

    /// Matches an upstream `serverRequest/resolved` notification's `params.requestId`
    /// against every connection's pending approval set (the request went out on this
    /// proxy's single upstream) and emits [`RemoteProxyEvent::ApprovalResolved`] when it
    /// was pending. Best-effort: oversized/opaque frames resolve nothing (the teardown
    /// drain, decision 5b, remains the backstop).
    fn handle_server_request_resolved_notification(&mut self, data: &[u8]) {
        if data.len() > MAX_FULL_PARSE_BYTES {
            return;
        }
        let Ok(parsed) = serde_json::from_slice::<Value>(data) else {
            return;
        };
        let Some(request_id_value) = parsed.pointer("/params/requestId") else {
            return;
        };
        // The wire may carry the id as a string ("41") or a number (41); a pending
        // RequestId::Int(41) must resolve either way.
        let (candidates, request_id) = match request_id_value {
            Value::String(s) => {
                let mut candidates = vec![RequestId::Str(s.clone())];
                if let Ok(n) = s.parse::<i64>() {
                    candidates.push(RequestId::Int(n));
                }
                (candidates, s.clone())
            }
            Value::Number(n) => match n.as_i64() {
                Some(n) => (vec![RequestId::Int(n)], n.to_string()),
                None => return,
            },
            _ => return,
        };
        let mut resolved = false;
        for conn in self.connections.values_mut() {
            for candidate in &candidates {
                if conn.pending_server_approvals.remove(candidate) {
                    resolved = true;
                }
            }
        }
        if resolved {
            self.emit(RemoteProxyEvent::ApprovalResolved { request_id });
        }
    }

    fn handle_thread_start_response(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        req_id: Option<RequestId>,
    ) {
        // Legacy parity (`handleThreadStartResponse`, `remote-proxy.ts:526-543`): a frame
        // small enough for a full parse is forwarded REGARDLESS — the candidate is emitted
        // only when the response actually carries a valid thread
        // (`maybeEmitThreadStartResponseCandidate`, `remote-proxy.ts:513-524`); e.g. a
        // JSON-RPC ERROR response to thread/start relays untouched. Only an OVERSIZED
        // frame takes the strict extract-or-fail-closed path.
        if data.len() <= MAX_FULL_PARSE_BYTES {
            if let Some(req_id) = req_id {
                let mut pending = HashSet::new();
                pending.insert(req_id);
                if let Ok(candidate) = extract_thread_start_response_candidate(
                    &data,
                    &ThreadStartResponseOptions {
                        pending_thread_start_request_ids: &pending,
                    },
                ) {
                    self.emit(RemoteProxyEvent::Candidate(candidate));
                }
            }
            self.send_to_client(conn_id, data, binary);
            return;
        }

        let Some(req_id) = req_id else {
            self.fail_unsafe_upstream_frame(
                conn_id,
                Some("thread/start"),
                "id_not_pending_thread_start",
            );
            return;
        };
        let mut pending = HashSet::new();
        pending.insert(req_id);
        match extract_thread_start_response_candidate(
            &data,
            &ThreadStartResponseOptions {
                pending_thread_start_request_ids: &pending,
            },
        ) {
            Ok(candidate) => {
                self.emit(RemoteProxyEvent::Candidate(candidate));
                self.send_to_client(conn_id, data, binary);
            }
            Err(reason) => {
                self.fail_unsafe_upstream_frame(
                    conn_id,
                    Some("thread/start"),
                    &format!("{reason:?}"),
                );
            }
        }
    }

    fn handle_thread_fork_response(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        req_id: Option<RequestId>,
        parent_thread_id: Option<String>,
    ) {
        let Some(req_id) = req_id else {
            self.fail_unsafe_upstream_frame(conn_id, Some("thread/fork"), "id_not_pending_fork");
            return;
        };
        if let Some(conn) = self.connections.get_mut(&conn_id) {
            conn.pending_fork_requests.remove(&req_id);
        }

        let mut pending = HashSet::new();
        pending.insert(req_id);
        let candidate = match extract_fork_response_candidate(
            &data,
            &ForkResponseOptions {
                parent_thread_id: parent_thread_id.as_deref(),
                pending_fork_request_ids: &pending,
            },
        ) {
            Ok(candidate) => candidate,
            Err(reason) => {
                self.fail_unsafe_upstream_frame(
                    conn_id,
                    Some("thread/fork"),
                    &format!("{reason:?}"),
                );
                return;
            }
        };

        let normalized = match normalize_thread_fork_response_for_tui(&data) {
            Ok(bytes) => bytes,
            Err(reason) => {
                self.fail_unsafe_upstream_frame(
                    conn_id,
                    Some("thread/fork"),
                    &format!("{reason:?}"),
                );
                return;
            }
        };
        if normalized.len() > self.max_raw_forward_bytes {
            self.fail_unsafe_upstream_frame(
                conn_id,
                Some("thread/fork"),
                "raw_forward_cap_exceeded",
            );
            return;
        }

        self.emit(RemoteProxyEvent::Candidate(candidate));
        self.send_to_client(conn_id, normalized, binary);
    }

    /// `handleStatefulUpstreamNotification` (`remote-proxy.ts:589-616`), sans the
    /// fork-handoff identity-gate hold branch (deferred; see module docs).
    fn handle_stateful_upstream_notification(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        method: &str,
    ) {
        match self.stateful_notification_effects(&data, method) {
            Some(effects) => {
                self.apply_upstream_side_effects(effects);
                self.send_to_client(conn_id, data, binary);
            }
            None => {
                if data.len() > MAX_FULL_PARSE_BYTES {
                    self.fail_unsafe_upstream_frame(
                        conn_id,
                        Some(method),
                        "unrecoverable_stateful_frame",
                    );
                } else {
                    self.send_to_client(conn_id, data, binary);
                }
            }
        }
    }

    /// Assembles the side effects for one stateful notification frame
    /// (`collectParsedUpstreamNotificationSideEffects` + `extractLargeUpstreamNotificationSideEffects`,
    /// `remote-proxy.ts:618-766`). For `thread/started`/`fs/changed`/`thread/closed`/
    /// `thread/status/changed` the emitted shape never depends on frame size (no "full
    /// params passthrough" concept for these), so the Slice-1 byte-scan extractors are
    /// used unconditionally; only `turn/started`/`turn/completed` get the genuinely
    /// size-conditional dual path (full params on small frames, reduced fields on
    /// oversized ones) — see [`Hub::turn_notification_effects`].
    fn stateful_notification_effects(&mut self, data: &[u8], method: &str) -> Option<Effects> {
        match method {
            "thread/started" => {
                let extracted = extract_thread_started_notification_side_effects(data).ok()?;
                Some(Effects {
                    candidates: vec![extracted.candidate],
                    thread_started: vec![extracted.lifecycle],
                    ..Default::default()
                })
            }
            "turn/started" | "turn/completed" => self.turn_notification_effects(data, method),
            "fs/changed" => {
                let trigger = extract_fs_changed_repair_trigger(data).ok()?;
                Some(Effects {
                    repair_triggers: vec![RemoteProxyRepairTrigger::FsChanged {
                        watch_id: trigger.watch_id,
                        changed_paths: trigger.changed_paths,
                    }],
                    ..Default::default()
                })
            }
            "thread/closed" | "thread/status/changed" => {
                let event = extract_thread_lifecycle_event(data).ok()?;
                Some(lifecycle_effects_from_event(event))
            }
            _ => None,
        }
    }

    fn turn_notification_effects(&mut self, data: &[u8], method: &str) -> Option<Effects> {
        if data.len() <= MAX_FULL_PARSE_BYTES {
            let Value::Object(root) = serde_json::from_slice::<Value>(data).ok()? else {
                return None;
            };
            let Some(Value::Object(params)) = root.get("params") else {
                return None;
            };
            let thread_id = params.get("threadId")?.as_str()?.to_string();
            if thread_id.is_empty() {
                return None;
            }
            let turn_id = params
                .get("turnId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let event = TurnEventParams {
                thread_id,
                turn_id,
                params: params.clone(),
            };
            return Some(if method == "turn/started" {
                Effects {
                    turn_started: vec![event],
                    ..Default::default()
                }
            } else {
                Effects {
                    turn_completed: vec![event],
                    ..Default::default()
                }
            });
        }

        let extracted = extract_turn_notification_event(data).ok()?;
        Some(match extracted {
            SideEffectTurnEvent::Started { thread_id, turn_id } => {
                let mut params = Map::new();
                params.insert("threadId".to_string(), Value::String(thread_id.clone()));
                if let Some(turn_id) = &turn_id {
                    params.insert("turnId".to_string(), Value::String(turn_id.clone()));
                }
                Effects {
                    turn_started: vec![TurnEventParams {
                        thread_id,
                        turn_id,
                        params,
                    }],
                    ..Default::default()
                }
            }
            SideEffectTurnEvent::Completed {
                thread_id,
                turn_id,
                status,
            } => {
                let mut params = Map::new();
                params.insert("threadId".to_string(), Value::String(thread_id.clone()));
                if let Some(turn_id) = &turn_id {
                    params.insert("turnId".to_string(), Value::String(turn_id.clone()));
                }
                if let Some(status) = &status {
                    params.insert("status".to_string(), Value::String(status.clone()));
                }
                Effects {
                    turn_completed: vec![TurnEventParams {
                        thread_id,
                        turn_id,
                        params,
                    }],
                    ..Default::default()
                }
            }
        })
    }

    fn apply_upstream_side_effects(&mut self, effects: Effects) {
        for candidate in effects.candidates {
            self.emit(RemoteProxyEvent::Candidate(candidate));
        }
        for lifecycle in effects.thread_started {
            self.emit(RemoteProxyEvent::ThreadStarted(lifecycle));
        }
        for params in effects.turn_started {
            self.record_turn_started(&params);
            self.emit(RemoteProxyEvent::TurnStarted(params));
        }
        for params in effects.turn_completed {
            self.record_turn_completed(&params);
            self.emit(RemoteProxyEvent::TurnCompleted(params));
        }
        for trigger in effects.repair_triggers {
            self.emit(RemoteProxyEvent::RepairTrigger(trigger));
        }
        for event in effects.lifecycle_events {
            self.emit(RemoteProxyEvent::ThreadLifecycle(event));
        }
        for event in effects.lifecycle_loss_events {
            self.emit(RemoteProxyEvent::ThreadLifecycleLoss(event));
        }
    }

    fn fail_unsafe_upstream_frame(&mut self, conn_id: u64, method: Option<&str>, reason: &str) {
        let message = match method {
            Some(method) => {
                format!("Codex remote proxy rejected an unsafe upstream {method} frame: {reason}.")
            }
            None => format!("Codex remote proxy rejected an unsafe upstream frame: {reason}."),
        };
        self.emit(RemoteProxyEvent::RepairTrigger(
            RemoteProxyRepairTrigger::ProxyError { message },
        ));
        self.close_connection(conn_id);
    }

    // ── turn/interrupt short-circuit for already-completed turns ────────────────────
    // (`recordTurnStarted/recordTurnCompleted/rememberCompletedTurnKey/completedTurnInterrupt`,
    // `remote-proxy.ts:1100-1132` — proxy-wide, not per-connection; see module docs.)

    fn record_turn_started(&mut self, params: &TurnEventParams) {
        let Some(turn_id) = &params.turn_id else {
            return;
        };
        let key = turn_key(&params.thread_id, turn_id);
        self.active_turn_keys.insert(key.clone());
        if self.completed_turn_keys_set.remove(&key) {
            self.completed_turn_keys_order.retain(|k| k != &key);
        }
    }

    fn record_turn_completed(&mut self, params: &TurnEventParams) {
        let Some(turn_id) = &params.turn_id else {
            return;
        };
        let key = turn_key(&params.thread_id, turn_id);
        self.active_turn_keys.remove(&key);
        self.remember_completed_turn_key(key);
    }

    fn remember_completed_turn_key(&mut self, key: String) {
        if self.completed_turn_keys_set.remove(&key) {
            self.completed_turn_keys_order.retain(|k| k != &key);
        }
        self.completed_turn_keys_set.insert(key.clone());
        self.completed_turn_keys_order.push_back(key);
        while self.completed_turn_keys_order.len() > MAX_COMPLETED_TURN_KEYS {
            if let Some(oldest) = self.completed_turn_keys_order.pop_front() {
                self.completed_turn_keys_set.remove(&oldest);
            }
        }
    }

    fn completed_turn_interrupt(&self, parsed: &Value) -> Option<()> {
        let obj = parsed.as_object()?;
        if obj.get("method")?.as_str()? != "turn/interrupt" {
            return None;
        }
        let params = obj.get("params")?.as_object()?;
        let thread_id = params.get("threadId")?.as_str()?;
        let turn_id = params.get("turnId")?.as_str()?;
        let key = turn_key(thread_id, turn_id);
        if self.completed_turn_keys_set.contains(&key) && !self.active_turn_keys.contains(&key) {
            Some(())
        } else {
            None
        }
    }
}

fn turn_key(thread_id: &str, turn_id: &str) -> String {
    format!("{thread_id}\u{0}{turn_id}")
}

fn lifecycle_effects_from_event(event: ThreadLifecycleEvent) -> Effects {
    match &event {
        ThreadLifecycleEvent::ThreadClosed { thread_id } => Effects {
            lifecycle_events: vec![event.clone()],
            lifecycle_loss_events: vec![ThreadLifecycleLossEvent::ThreadClosed {
                thread_id: thread_id.clone(),
            }],
            ..Default::default()
        },
        ThreadLifecycleEvent::ThreadStatusChanged { thread_id, status } => {
            let status_type = status.get("type").and_then(|v| v.as_str());
            let loss = match status_type {
                Some("notLoaded") | Some("systemError") => {
                    vec![ThreadLifecycleLossEvent::ThreadStatusChanged {
                        thread_id: thread_id.clone(),
                        status: status_type.unwrap().to_string(),
                    }]
                }
                _ => Vec::new(),
            };
            Effects {
                lifecycle_events: vec![event.clone()],
                lifecycle_loss_events: loss,
                ..Default::default()
            }
        }
    }
}

// ── shared small helpers ─────────────────────────────────────────────────────────────

/// Bridges the envelope scanner's lossy-`f64`-capable id ([`JsonRpcEnvelopeId`]) to the
/// precise [`RequestId`] used for pending-id correlation. See module docs for why a
/// non-integer/out-of-range numeric id intentionally yields `None` rather than a lossy
/// match.
fn envelope_id_to_request_id(id: &JsonRpcEnvelopeId) -> Option<RequestId> {
    match id {
        JsonRpcEnvelopeId::Str(s) => Some(RequestId::Str(s.clone())),
        JsonRpcEnvelopeId::Num(n) => {
            if n.is_finite() && n.fract() == 0.0 && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                Some(RequestId::Int(*n as i64))
            } else {
                None
            }
        }
    }
}

/// Canonicalizes a JSON-RPC id for the [`ApprovalRequestParams::request_id`] payload:
/// string ids verbatim, numeric ids via their canonical integer formatting (matching
/// [`envelope_id_to_json`]'s integer-literal preference).
fn envelope_id_to_string(id: &JsonRpcEnvelopeId) -> String {
    match id {
        JsonRpcEnvelopeId::Str(s) => s.clone(),
        JsonRpcEnvelopeId::Num(n) => {
            if n.fract() == 0.0 && n.is_finite() && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                (*n as i64).to_string()
            } else {
                n.to_string()
            }
        }
    }
}

/// The [`RequestId`] counterpart of [`envelope_id_to_string`] — used where only the
/// bridged pending-set key is at hand (response matching, teardown drains).
fn request_id_to_string(id: &RequestId) -> String {
    match id {
        RequestId::Int(n) => n.to_string(),
        RequestId::Str(s) => s.clone(),
    }
}

fn envelope_id_to_json(id: &JsonRpcEnvelopeId) -> Value {
    match id {
        JsonRpcEnvelopeId::Str(s) => Value::String(s.clone()),
        JsonRpcEnvelopeId::Num(n) => {
            // Prefer an integer literal for a whole-number id (matches the wire shape a
            // JS `JSON.stringify({id: 99, ...})` would produce — `99`, never `99.0`); fall
            // back to the lossless float form only when it genuinely isn't a whole number
            // (which `scan_top_level_id` never actually hands us as an `id`, but this stays
            // total rather than assuming that invariant).
            if n.fract() == 0.0 && n.is_finite() && *n >= i64::MIN as f64 && *n <= i64::MAX as f64 {
                Value::Number((*n as i64).into())
            } else {
                serde_json::Number::from_f64(*n)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
    }
}

fn client_envelope_failure_message(reason: JsonRpcEnvelopeScanError) -> String {
    if reason == JsonRpcEnvelopeScanError::BatchUnsupported {
        "Codex remote proxy rejected a JSON-RPC batch frame.".to_string()
    } else {
        format!("Codex remote proxy rejected an unsupported JSON-RPC frame: {reason:?}.")
    }
}

/// `extractThreadForkParentThreadId` (`remote-proxy.ts:1197-1213`): reads the ORIGINAL
/// (pre-rewrite) client `thread/fork` request's `params.threadId` — the parent thread id
/// — via a bounded byte scan (not a full parse), so this is safe to call regardless of
/// frame size.
fn extract_thread_fork_parent_thread_id(raw: &[u8]) -> Option<String> {
    use crate::json_scan::{
        decode_string_entry, find_entry, scan_object, skip_whitespace, ValueKind, BYTE_OPEN_BRACE,
    };
    use crate::remote_proxy_envelope::MAX_SCANNED_TOKEN_BYTES;

    let start = skip_whitespace(raw, 0);
    if start >= raw.len() || raw[start] != BYTE_OPEN_BRACE {
        return None;
    }
    let root = scan_object(raw, start, MAX_SCANNED_TOKEN_BYTES).ok()?;
    let params = find_entry(&root.entries, "params")?;
    if params.value_kind != ValueKind::Object {
        return None;
    }
    let params_object = scan_object(raw, params.value_start, MAX_SCANNED_TOKEN_BYTES).ok()?;
    let thread_id_entry = find_entry(&params_object.entries, "threadId")?;
    if thread_id_entry.value_kind != ValueKind::String {
        return None;
    }
    let value = decode_string_entry(raw, thread_id_entry).ok()?;
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_id_to_request_id_bridges_strings_and_small_integers_losslessly() {
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Str("abc".into())),
            Some(RequestId::Str("abc".into()))
        );
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(42.0)),
            Some(RequestId::Int(42))
        );
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(-7.0)),
            Some(RequestId::Int(-7))
        );
    }

    #[test]
    fn envelope_id_to_request_id_rejects_fractional_and_out_of_range_numbers() {
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(1.5)),
            None
        );
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(f64::MAX)),
            None
        );
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(f64::NAN)),
            None
        );
    }

    #[test]
    fn extract_thread_fork_parent_thread_id_reads_the_original_pre_rewrite_frame() {
        let raw = serde_json::json!({
            "id": 1,
            "method": "thread/fork",
            "params": {"threadId": "parent-1", "turns": [{"id": "t"}]},
        })
        .to_string();
        assert_eq!(
            extract_thread_fork_parent_thread_id(raw.as_bytes()),
            Some("parent-1".to_string())
        );
    }

    #[test]
    fn extract_thread_fork_parent_thread_id_is_none_for_malformed_or_missing_shapes() {
        assert_eq!(extract_thread_fork_parent_thread_id(b"not json"), None);
        assert_eq!(
            extract_thread_fork_parent_thread_id(br#"{"id":1,"method":"thread/fork","params":{}}"#),
            None
        );
    }
}
