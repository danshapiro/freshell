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
//! - **The "identity gate" (`initial_capture`/`fork_handoff` hold-until-persisted
//!   mechanism, `remote-proxy.ts:67-96,206-256,842-980`) is deliberately OUT OF SCOPE for
//!   this slice.** Its entire purpose is to hold `turn/start`/`thread/fork` client
//!   requests until a durability consumer calls `markCandidatePersisted()` — a consumer
//!   that does not exist until Slice 3/5 wire durability. Porting the hold-forever gate
//!   with nothing to ever release it would make every codex terminal pane in the interim
//!   worse, not safer. `CodexRemoteProxyOptions` therefore has no
//!   `require_candidate_persistence` knob yet; `mark_candidate_persisted`/
//!   `fail_candidate_capture`/`pause_candidate_capture`/`resume_candidate_capture` and the
//!   new-connection-rejection-after-failure path are not ported. Add them when Slice 3
//!   defines what "persisted" means and wires the call.
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

/// `MAX_COMPLETED_TURN_KEYS` (`remote-proxy.ts:95`).
const MAX_COMPLETED_TURN_KEYS: usize = 256;

// ── public options / errors ─────────────────────────────────────────────────────────

/// Constructor options (`CodexRemoteProxyOptions`, `remote-proxy.ts:84-91`) — scoped to
/// what this slice ports (see module docs for what's deliberately absent).
#[derive(Clone, Debug)]
pub struct CodexRemoteProxyOptions {
    pub upstream_ws_url: String,
    /// `maxRawForwardBytes` (`remote-proxy.ts:90,141`); default [`MAX_RAW_FORWARD_BYTES`].
    pub max_raw_forward_bytes: usize,
}

impl CodexRemoteProxyOptions {
    pub fn new(upstream_ws_url: impl Into<String>) -> Self {
        Self {
            upstream_ws_url: upstream_ws_url.into(),
            max_raw_forward_bytes: MAX_RAW_FORWARD_BYTES,
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
                write!(f, "codex remote proxy failed to bind a loopback listener: {message}")
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

/// The lifecycle-LOSS subset of thread lifecycle notifications (`CodexThreadLifecycleLossEvent`,
/// `client.ts`, consumed at `remote-proxy.ts:669,677-681,745,751-756`): `thread/closed`
/// always; `thread/status/changed` only for the two loss-worthy statuses.
#[derive(Clone, Debug, PartialEq)]
pub enum ThreadLifecycleLossEvent {
    ThreadClosed { thread_id: String },
    ThreadStatusChanged { thread_id: String, status: String },
}

/// `CodexRemoteProxyRepairTrigger` (`remote-proxy.ts:36-38`) — scoped to the variants this
/// slice's relay loop can actually produce; `candidate_capture_timeout` is omitted (it's
/// the deferred identity-gate's, see module docs).
#[derive(Clone, Debug, PartialEq)]
pub enum RemoteProxyRepairTrigger {
    ProxyClose,
    ProxyError { message: String },
    FsChanged { watch_id: String, changed_paths: Vec<String> },
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
}

// ── the proxy handle ─────────────────────────────────────────────────────────────────

/// A running codex remote proxy. Own it for the lifetime of the codex terminal pane it
/// serves; call [`CodexRemoteProxy::close`] to tear it down.
pub struct CodexRemoteProxy {
    ws_url: String,
    hub_tx: mpsc::UnboundedSender<HubMsg>,
    accept_task: JoinHandle<()>,
    hub_task: JoinHandle<()>,
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

        let hub_task = tokio::spawn(run_hub(hub_rx, events_tx, options.max_raw_forward_bytes));

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
            },
            events_rx,
        ))
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Tear down the listener and every active client/upstream socket pair
    /// (`close()`, `remote-proxy.ts:178-204` — sans the identity-gate held-frame drain,
    /// deliberately out of scope here; see module docs).
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

async fn dial_upstream(conn_id: u64, upstream_ws_url: String, hub_tx: mpsc::UnboundedSender<HubMsg>) {
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
}

impl ConnState {
    fn new() -> Self {
        Self {
            client_tx: None,
            upstream_tx: None,
            pending_to_upstream: VecDeque::new(),
            pending_methods: HashMap::new(),
            pending_fork_requests: HashMap::new(),
        }
    }
}

struct Hub {
    connections: HashMap<u64, ConnState>,
    max_raw_forward_bytes: usize,
    active_turn_keys: HashSet<String>,
    completed_turn_keys_set: HashSet<String>,
    completed_turn_keys_order: VecDeque<String>,
    events_tx: mpsc::UnboundedSender<RemoteProxyEvent>,
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
) {
    let mut hub = Hub {
        connections: HashMap::new(),
        max_raw_forward_bytes,
        active_turn_keys: HashSet::new(),
        completed_turn_keys_set: HashSet::new(),
        completed_turn_keys_order: VecDeque::new(),
        events_tx,
    };

    while let Some(msg) = rx.recv().await {
        match msg {
            HubMsg::ClientConnected { conn_id, tx } => {
                let conn = hub.connections.entry(conn_id).or_insert_with(ConnState::new);
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
                hub.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message: "Codex remote proxy could not connect to the upstream app-server."
                        .to_string(),
                }));
                hub.close_connection(conn_id);
            }
            HubMsg::ClientFrame { conn_id, data, binary } => {
                hub.handle_client_frame(conn_id, data, binary);
            }
            HubMsg::UpstreamFrame { conn_id, data, binary } => {
                hub.handle_upstream_frame(conn_id, data, binary);
            }
            HubMsg::ClientClosed { conn_id } => {
                hub.close_connection(conn_id);
            }
            HubMsg::ClientErrored { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message: "Codex remote proxy client connection errored.".to_string(),
                }));
                hub.close_connection(conn_id);
            }
            HubMsg::UpstreamClosed { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyClose));
                hub.close_connection(conn_id);
            }
            HubMsg::UpstreamErrored { conn_id } => {
                hub.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message: "Codex remote proxy upstream connection errored.".to_string(),
                }));
                hub.close_connection(conn_id);
            }
            HubMsg::Shutdown { done } => {
                for (_, conn) in hub.connections.drain() {
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
            None => conn.pending_to_upstream.push_back(OutFrame { data, binary }),
        }
    }

    fn send_json_rpc_error_to_client(&self, conn_id: u64, id: Option<&JsonRpcEnvelopeId>, message: &str) {
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
            self.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                message: "Codex remote proxy rejected a JSON-RPC frame because it is too large."
                    .to_string(),
            }));
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
                self.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message: client_envelope_failure_message(reason),
                }));
                self.close_connection(conn_id);
                return;
            }
        };

        let method = envelope.method.clone();
        let id = envelope.id.clone();

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
        if let (Some(id), Some(method)) = (
            id.as_ref().and_then(envelope_id_to_request_id),
            method,
        ) {
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                conn.pending_methods.insert(id, method);
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
        self.forward_client_frame(conn_id, rewritten, binary, id, Some("thread/fork".to_string()));
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
            let req_id = envelope_id_to_request_id(&id);
            let (method, fork_request) = match self.connections.get_mut(&conn_id) {
                Some(conn) => {
                    let method = req_id.as_ref().and_then(|rid| conn.pending_methods.remove(rid));
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
            if STATEFUL_NOTIFICATION_METHODS.contains(&method) {
                self.handle_stateful_upstream_notification(conn_id, data, binary, method);
                return;
            }
        }
        self.send_to_client(conn_id, data, binary);
    }

    fn handle_thread_start_response(
        &mut self,
        conn_id: u64,
        data: Vec<u8>,
        binary: bool,
        req_id: Option<RequestId>,
    ) {
        let Some(req_id) = req_id else {
            self.fail_unsafe_upstream_frame(conn_id, Some("thread/start"), "id_not_pending_thread_start");
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
                self.fail_unsafe_upstream_frame(conn_id, Some("thread/start"), &format!("{reason:?}"));
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
                self.fail_unsafe_upstream_frame(conn_id, Some("thread/fork"), &format!("{reason:?}"));
                return;
            }
        };

        let normalized = match normalize_thread_fork_response_for_tui(&data) {
            Ok(bytes) => bytes,
            Err(reason) => {
                self.fail_unsafe_upstream_frame(conn_id, Some("thread/fork"), &format!("{reason:?}"));
                return;
            }
        };
        if normalized.len() > self.max_raw_forward_bytes {
            self.fail_unsafe_upstream_frame(conn_id, Some("thread/fork"), "raw_forward_cap_exceeded");
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
                    self.fail_unsafe_upstream_frame(conn_id, Some(method), "unrecoverable_stateful_frame");
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
            let turn_id = params.get("turnId").and_then(|v| v.as_str()).map(str::to_string);
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
                    turn_started: vec![TurnEventParams { thread_id, turn_id, params }],
                    ..Default::default()
                }
            }
            SideEffectTurnEvent::Completed { thread_id, turn_id, status } => {
                let mut params = Map::new();
                params.insert("threadId".to_string(), Value::String(thread_id.clone()));
                if let Some(turn_id) = &turn_id {
                    params.insert("turnId".to_string(), Value::String(turn_id.clone()));
                }
                if let Some(status) = &status {
                    params.insert("status".to_string(), Value::String(status.clone()));
                }
                Effects {
                    turn_completed: vec![TurnEventParams { thread_id, turn_id, params }],
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
        self.emit(RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }));
        self.close_connection(conn_id);
    }

    // ── turn/interrupt short-circuit for already-completed turns ────────────────────
    // (`recordTurnStarted/recordTurnCompleted/rememberCompletedTurnKey/completedTurnInterrupt`,
    // `remote-proxy.ts:1100-1132` — proxy-wide, not per-connection; see module docs.)

    fn record_turn_started(&mut self, params: &TurnEventParams) {
        let Some(turn_id) = &params.turn_id else { return };
        let key = turn_key(&params.thread_id, turn_id);
        self.active_turn_keys.insert(key.clone());
        if self.completed_turn_keys_set.remove(&key) {
            self.completed_turn_keys_order.retain(|k| k != &key);
        }
    }

    fn record_turn_completed(&mut self, params: &TurnEventParams) {
        let Some(turn_id) = &params.turn_id else { return };
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
                Some("notLoaded") | Some("systemError") => vec![ThreadLifecycleLossEvent::ThreadStatusChanged {
                    thread_id: thread_id.clone(),
                    status: status_type.unwrap().to_string(),
                }],
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
                serde_json::Number::from_f64(*n).map(Value::Number).unwrap_or(Value::Null)
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
    use crate::json_scan::{decode_string_entry, find_entry, scan_object, skip_whitespace, ValueKind, BYTE_OPEN_BRACE};
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
        assert_eq!(envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(1.5)), None);
        assert_eq!(
            envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(f64::MAX)),
            None
        );
        assert_eq!(envelope_id_to_request_id(&JsonRpcEnvelopeId::Num(f64::NAN)), None);
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
