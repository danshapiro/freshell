//! # freshell-ws
//!
//! WebSocket transport + connect-handshake dispatch for the freshell Rust port.
//! A faithful port of the **handshake path** of `server/ws-handler.ts`:
//!
//! * mount `/ws` (an axum WebSocket upgrade — tokio-tungstenite-backed);
//! * read the first `hello`, validate `protocolVersion == 7` **first**, then the
//!   token with a **constant-time** compare (mirrors `auth.ts#timingSafeCompare`
//!   and the `ws-handler.ts` ordering: version check precedes auth);
//! * on success emit, IN ORDER, exactly what the original sends on a clean
//!   isolated boot: `ready` → `settings.updated` → `perf.logging` →
//!   `terminal.inventory`, with the `terminal.inventory.bootId`
//!   **byte-identical** to the `ready.bootId` (the cross-message invariant the
//!   oracle normalizer + determinism test pin).
//!
//! After the handshake, the connection is handed to [`terminal`], which serves the
//! `terminal.*` shell path (create/attach/input/output/kill) over the same socket —
//! the transport the oracle's T1 rung grades (`port/machine/specs/terminal-core.md`).
//! Coding-cli, fresh-agent, backpressure, and keepalive ping remain out of scope.
//! The crate emits the frozen [`freshell_protocol`] server-message types so its
//! wire bytes are contract-locked.

pub mod activity;
pub mod amplifier_association;
pub mod backpressure;
pub mod identity;
pub(crate) mod invariants;
pub mod opencode_association;
pub mod origin;
pub mod screenshot;
pub mod tabs;
pub mod tabs_persist;
pub mod terminal;

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::Response,
    routing::get,
    Router,
};
use freshell_protocol::{
    ConfigFallback, ErrorCode, ErrorMsg, PerfLogging, Ready, ServerMessage, ServerSettings,
    SettingsUpdated, TerminalInventory, WS_PROTOCOL_VERSION,
};

/// Shared, cheaply-cloneable state the `/ws` handler needs. Boot-scoped ids are
/// generated once by `freshell-server` and injected here so every connection in
/// a boot reports the SAME `serverInstanceId`/`bootId` (matches the original,
/// where they live on the single `WsHandler`).
#[derive(Clone)]
pub struct WsState {
    /// The required WS auth token (`AUTH_TOKEN`).
    pub auth_token: Arc<String>,
    /// `srv-<uuid>` — stable for the life of this server process.
    pub server_instance_id: Arc<String>,
    /// `boot-<uuid>` — stable for the life of this server process.
    pub boot_id: Arc<String>,
    /// The default server settings tree emitted in `settings.updated`.
    pub settings: Arc<ServerSettings>,
    /// GAP1 (CFG-03 checklist follow-up): the boot-time `config.fallback`
    /// notice, if the primary configuration needed to fall back (corrupt
    /// primary -> backup restore or defaults) at boot -- `None` for a
    /// healthy config or an ordinary fresh install. Boot-frozen, exactly
    /// like `settings` above (the original recomputes both `settings` AND
    /// `configFallback` fresh on every connection, `server/index.ts:369-381`;
    /// this crate already snapshots `settings` once at boot into `WsState`,
    /// so this field follows that SAME established precedent rather than
    /// inventing new live-recompute plumbing). Sent as part of
    /// [`build_handshake`]'s ordered handshake on EVERY `/ws` connection --
    /// not just the first -- so a client that connects minutes after boot
    /// still receives it (mirrors the original's per-connection
    /// `sendHandshakeSnapshot`, `ws-handler.ts:1723-1749`, which is how it
    /// achieves late-connect delivery without a separate broadcast).
    pub config_fallback: Option<ConfigFallback>,
    /// The shared server→client broadcast bus (pre-serialized JSON frames). REST
    /// handlers (e.g. fresh-agent create/send) push here; every authenticated `/ws`
    /// connection fans the frames out to its socket (the original `WsHandler.broadcast`).
    /// Carries `ui.command` / `freshAgent.session.materialized` / `sessions.changed`
    /// during a fresh-agent turn, which the oracle's capture socket records.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// The freshcodex WS fresh-agent slice: the post-handshake loop dispatches
    /// `freshAgent.create` / `freshAgent.send` (codex) here, which spawns the codex
    /// app-server sidecar and broadcasts `freshAgent.created` / `freshAgent.send.accepted`
    /// / `freshAgent.event` (session.snapshot + the status-guarded turn.complete edge).
    pub fresh_codex: freshell_freshagent::FreshCodexState,
    /// The freshclaude WS fresh-agent slice: the post-handshake loop dispatches
    /// `freshAgent.create` / `freshAgent.send` (claude/kilroy) here, which spawns the ONE
    /// sanctioned Node sidecar wrapping `@anthropic-ai/claude-agent-sdk` and broadcasts
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.event`
    /// (session.init + stream + assistant + result + the success-guarded turn.complete edge).
    /// Gated by the SHARED `settings.freshAgent.enabled` flag (owned by `fresh_codex`).
    pub fresh_claude: freshell_freshagent::FreshClaudeState,
    /// The freshopencode WS fresh-agent slice (Batch D PR-2): the post-handshake loop
    /// dispatches `freshAgent.create` / `freshAgent.send` / `freshAgent.kill` /
    /// `freshAgent.interrupt` (opencode) here. Wraps the SAME `FreshAgentState` the REST
    /// `/api/tabs` + `/api/panes/:id/send-keys` surface uses, so both share exactly ONE
    /// `opencode serve` sidecar. Streaming (`freshAgent.event`) is PR-3.
    pub fresh_opencode: freshell_freshagent::FreshOpencodeState,
    /// The shared, connection-independent terminal registry (the port of
    /// `server/terminal-registry.ts` plus the broker fan-out). Terminals are owned here
    /// by `terminalId`, NOT by the connection that created them, so a second/reconnected
    /// socket re-attaches to a running PTY and replays its scrollback. This is what makes
    /// the multi-client / reconnection / hot-across-reload flows work
    /// (`port/machine/specs/terminal-core.md` §1).
    pub registry: freshell_terminal::TerminalRegistry,
    /// The shared, in-memory tabs registry (the `tabs.sync.*` slice of
    /// `server/ws-handler.ts` + `server/tabs-registry/store.ts`). Owned here by
    /// `(deviceId, clientInstanceId)` so every `/ws` connection — and the REST
    /// `client-retire` beacon — shares one cross-device tab view. This is what makes
    /// a closed device's tab disappear from other clients' Tabs UI.
    pub tabs: crate::tabs::TabsRegistry,
    /// The shared terminal-identity registry (Fix Spec: Session Naming Cluster --
    /// the port-side closure of `TerminalMetadataService`'s provider/sessionId
    /// association slice, see [`crate::identity`]). Populated at terminal-create
    /// time alongside the `terminal.meta.updated` broadcast, retired (not removed)
    /// on kill/exit so post-exit rename cascades still resolve. Shared into the
    /// `freshell-server` REST states (`TerminalsState`/`SessionsState`/
    /// `SessionDirectoryState`) that read it for the rename cascades and the
    /// session-directory live-terminal join.
    pub identity: crate::identity::TerminalIdentityRegistry,
    /// The shared UI-screenshot broker (`ws-handler.ts#requestUiScreenshot`). A
    /// connection that advertised `capabilities.uiScreenshotV1` is counted here so
    /// `POST /api/screenshots` knows a capable UI exists, and its inbound
    /// `ui.screenshot.result` is routed back to the waiting REST handler.
    pub screenshots: crate::screenshot::ScreenshotBroker,
    /// The handler-scoped monotonic `terminals.changed` revision counter
    /// (`ws-handler.ts:566` `terminalsRevision`). SHARED with the REST
    /// `/api/terminals` PATCH/DELETE broadcasts (`terminals::TerminalsState`),
    /// so WS create/kill and REST override changes stamp ONE monotonic sequence,
    /// exactly like the original's single per-handler counter.
    pub terminals_revision: Arc<std::sync::atomic::AtomicI64>,
    /// SESSION-09: the monotonic `sessions.changed` revision counter for the
    /// periodic session-directory sweep (`freshell-server`'s
    /// `spawn_sessions_sweep`, `main.rs`). Legacy's `SessionsSyncService`
    /// (`server/sessions-sync/service.ts:31-73`) owns ONE such counter per
    /// server process and stamps it on every coalesced directory-change
    /// broadcast (`ws-handler.ts:3662-3668` `broadcastAuthenticated`); this
    /// field is that same per-process counter for the port. NOTE: this is
    /// deliberately independent of `freshell-freshagent`'s own internal
    /// `sessions_revision` (used only for the narrower
    /// placeholder-\u2192durable materialization broadcast on a fresh-agent
    /// turn) -- the two are not unified in this slice; see
    /// `crate::terminal::broadcast_sessions_changed`'s doc comment for the
    /// known consequence.
    pub sessions_revision: Arc<std::sync::atomic::AtomicI64>,
    /// The registered coding-CLI command specs (`claude`/`codex`/`opencode`/...),
    /// used to resolve `terminal.create { mode: <cli> }` into a real CLI launch
    /// (`resolveCodingCliCommand`). Populated from the extension registry at boot;
    /// empty in unit tests (shell-only).
    pub cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    /// Graceful-shutdown signal (`ws-handler.ts:1087` / `:3843`): on SIGTERM/SIGINT
    /// the server notifies every live connection, which closes with
    /// `4009 "Server shutting down"` (CLOSE_CODES.SERVER_SHUTDOWN) — live-pinned
    /// 2026-07-13: the original's client observes {code:4009, reason:'Server
    /// shutting down'}; the port previously died with an abnormal 1006.
    pub shutdown: Arc<tokio::sync::Notify>,
    /// WS protocol-level keepalive ping interval, milliseconds (`ws-handler.ts:224`
    /// `pingIntervalMs: Number(process.env.PING_INTERVAL_MS || 30_000)`). Every
    /// `/ws` connection's serve loop (`terminal::run`) pings on this cadence and
    /// terminates the socket if no pong arrived since the previous tick (mirrors
    /// `ws.isAlive` / `ws.terminate()`, `ws-handler.ts:745-755`). Without this, an
    /// idle connection carries zero traffic and a silent intermediary (NAT/proxy/
    /// dead network path) can black-hole it — the client's `readyState` stays
    /// `OPEN` while every broadcast frame the server sends is lost. A small value
    /// here (e.g. in tests) makes the keepalive cadence observable without a real
    /// 30s wait.
    pub ping_interval_ms: u64,
    /// SAFE-05: hello-handshake deadline, milliseconds (`ws-handler.ts:223`
    /// `helloTimeoutMs: Number(process.env.HELLO_TIMEOUT_MS || 5_000)`). A
    /// connection that never completes its `hello` within this window is
    /// closed with `CLOSE_HELLO_TIMEOUT` (4002), mirroring `ws-handler.ts:1167-1171`
    /// (`state.helloTimer = setTimeout(() => { if (!state.authenticated)
    /// ws.close(CLOSE_CODES.HELLO_TIMEOUT, 'Hello timeout') }, helloTimeoutMs)`).
    /// A small value here (e.g. in tests) makes the deadline observable
    /// without a real multi-second wait.
    pub hello_timeout_ms: u64,
    /// SAFE-03 WS Origin policy allow-list (resolved once at boot from
    /// `ALLOWED_ORIGINS`/`EXTRA_ALLOWED_ORIGINS`, see [`crate::origin`]). A
    /// connection whose `Origin` is present but neither same-origin (Host
    /// match) nor on this list is rejected before any session state is sent.
    pub allowed_origins: Arc<Vec<String>>,
    /// TERM-09: bounded per-connection output-queue + catastrophic-backpressure
    /// tunables (legacy parity: `server/terminal-stream/constants.ts` +
    /// `client-output-queue.ts`). See [`crate::backpressure::Term09Config`].
    pub term09: crate::backpressure::Term09Config,
    /// SAFE-06: inbound WS frame/message size bound (legacy parity:
    /// `ws-handler.ts:226` `wsMaxPayloadBytes: Number(process.env.WS_MAX_PAYLOAD_BYTES
    /// || 16 * 1024 * 1024)`, passed to the `ws` library's `maxPayload` at
    /// `ws-handler.ts:728`, which aborts a connection whose message exceeds
    /// it). Configured once at boot (mirrors `ping_interval_ms`) and applied
    /// to the `WebSocketUpgrade` before `.on_upgrade()` in [`ws_handler`], so
    /// both the `hello` frame and every later `terminal.*` frame on this
    /// connection are bounded identically.
    pub ws_max_payload_bytes: usize,
    /// The amplifier session locator (restore-across-restart fix,
    /// `docs/plans/2026-07-18-amplifier-restore-spec.md`): correlates a fresh
    /// amplifier PTY's first Enter/submit with the new
    /// `~/.amplifier/projects/.../sessions/<id>/` dir amplifier lazily creates,
    /// so the terminal can be bound to a session identity and `terminal.rs`'s
    /// generic resume-id derivation can drive `amplifier resume <id>` on
    /// restart. `None` when the provider home couldn't be resolved (mirrors
    /// `SessionDirectoryState::session_index`'s `Option` convention) -- every
    /// [`crate::amplifier_association`] entry point no-ops in that case.
    pub amplifier_locator: Option<Arc<freshell_sessions::amplifier_locator::AmplifierLocator>>,
    /// The opencode terminal-pane session locator (restore-across-restart fix,
    /// `docs/plans/2026-07-18-opencode-terminal-restore-spec.md`): correlates a
    /// fresh opencode PTY's first Enter/submit (or a row written at spawn) with
    /// the new root `session` row opencode writes into its SQLite
    /// `opencode.db`, so the terminal can be bound to a session identity and
    /// `terminal.rs`'s generic resume-id derivation can drive
    /// `opencode --session <id>` on restart. `None` when the data home
    /// couldn't be resolved — every [`crate::opencode_association`] entry
    /// point no-ops in that case. Sibling to `amplifier_locator` (spec §8: a
    /// provider-parameterized locator was explicitly rejected).
    pub opencode_locator: Option<Arc<freshell_sessions::opencode_locator::OpencodeLocator>>,
    /// TERM-15/TERM-16: the terminal-mode CLI activity hub (claude/codex/
    /// amplifier trackers + the truly-idle gate + the amplifier events
    /// lanes). `None` in unit tests that never exercise activity; always
    /// `Some` on a real boot (`freshell-server` constructs it and installs
    /// its registry observer). `*.activity.list` requests answer with empty
    /// lists when `None` — same wire shape as "no busy terminals".
    pub activity: Option<crate::activity::ActivityHub>,
}

/// The `/ws` sub-router, pre-bound to its state (mergeable into the server app).
pub fn router(state: WsState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: axum::http::HeaderMap,
    State(state): State<WsState>,
) -> Response {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // SAFE-06: bound BOTH the frame size and the reassembled-message size to
    // the same value (legacy's `ws` library only exposes one `maxPayload`
    // knob, applied to the fully-reassembled message; this protocol never
    // fragments a JSON frame across multiple WS frames, so a single shared
    // bound is a faithful, simpler mapping). Applied on the upgrade itself so
    // it governs every read on this connection, including the pre-handshake
    // `hello` frame.
    let max_payload = state.ws_max_payload_bytes;
    ws.max_message_size(max_payload)
        .max_frame_size(max_payload)
        .on_upgrade(move |socket| handle_socket(socket, state, origin, host))
}

/// Constant-time byte-slice equality. Mirrors `auth.ts#timingSafeCompare`:
/// unequal lengths short-circuit to `false`, equal lengths XOR-accumulate so the
/// comparison time does not depend on WHERE the first mismatch is.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Current time as an ISO-8601 / RFC-3339 string with millisecond precision and
/// a `Z` suffix — byte-shape-compatible with JS `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Run `f` on a repeating `interval` cadence, forever, on a spawned tokio task.
/// The generic scheduling primitive behind `spawn_idle_monitor` -- split out so
/// the ticker cadence itself (the actual new logic: a `tokio::time::interval`
/// loop) is unit-testable with a fast interval + a plain counter, independent
/// of any terminal-registry domain behavior (which
/// `freshell_terminal::TerminalRegistry::enforce_idle_kills` already tests
/// exhaustively).
fn spawn_periodic(interval: std::time::Duration, mut f: impl FnMut() + Send + 'static) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            f();
        }
    });
}

/// Start the background idle-reaper task (TERM-11, `autoKillIdleMinutes`):
/// legacy `startIdleMonitor` + `enforceIdleKills` (`terminal-registry.ts:1335-1425`),
/// a 30s sweep cadence in production (`tr:1339`). Lives here, not
/// `freshell-terminal` (deliberately tokio-free -- see that crate's module
/// docs), for the same reason the WS keepalive ping ticker lives in
/// `terminal.rs`: the periodic timer needs an async runtime.
///
/// Call once at boot (`freshell-server`'s `main`), after `TerminalRegistry::new()`
/// and after seeding `registry.set_auto_kill_idle_minutes(settings.safety.auto_kill_idle_minutes)`
/// from the loaded settings -- the registry itself owns the CURRENT threshold
/// (`TerminalRegistry::auto_kill_idle_minutes`), so this sweep always reads
/// whatever value was most recently set, with zero coupling to settings types.
pub fn spawn_idle_monitor(
    registry: freshell_terminal::TerminalRegistry,
    sweep_interval: std::time::Duration,
) {
    spawn_periodic(sweep_interval, move || {
        registry.enforce_idle_kills();
    });
}

/// Build the ordered connect-handshake the original emits on a clean isolated
/// boot. The `bootId` is shared by value between `ready` and `terminal.inventory`
/// so both normalize to the same placeholder (the cross-message invariant).
///
/// `terminal.inventory.terminals` is sourced from the shared [`WsState::registry`]
/// (`registry.list()`, `ws-handler.ts:1737-1745`): a reconnecting/second socket
/// learns which PTYs are still alive so the SPA re-attaches to them instead of
/// treating its persisted terminals as dead (`clearDeadTerminals` → recreate, which
/// would lose scrollback). On a truly fresh boot the registry is empty, so this stays
/// byte-identical to the clean-boot handshake the oracle's T0/determinism tiers pin.
pub fn build_handshake(state: &WsState) -> Vec<ServerMessage> {
    let boot_id = state.boot_id.as_ref().clone();
    let mut messages = vec![
        ServerMessage::Ready(Ready {
            timestamp: now_iso(),
            boot_id: Some(boot_id.clone()),
            server_instance_id: Some(state.server_instance_id.as_ref().clone()),
        }),
        ServerMessage::SettingsUpdated(SettingsUpdated {
            settings: state.settings.as_ref().clone(),
        }),
        ServerMessage::PerfLogging(PerfLogging { enabled: false }),
    ];
    // GAP1 (CFG-03 checklist follow-up): `config.fallback` slots in right
    // after `perf.logging`, mirroring the original's exact ordering
    // (`ws-handler.ts:1730-1735`: `settings.updated` -> `perf.logging` ->
    // `config.fallback` -> `terminal.inventory`). Sent on EVERY connection
    // this `build_handshake` call produces (called fresh per `/ws` upgrade
    // in `handle_socket`), so a late-connecting client sees it too --
    // exactly like the original's per-connection `sendHandshakeSnapshot`.
    if let Some(config_fallback) = state.config_fallback.clone() {
        messages.push(ServerMessage::ConfigFallback(config_fallback));
    }
    // STATE-SYNC FIX 1 increment 2a: stamp each inventory row with the
    // canonical identity from the shared registry (create-time resume ids AND
    // locator-associated ids both live there) -- the frozen client's
    // reconnect reconcile loop (`src/App.tsx:976-985`) keys off this field
    // and was dead code against this port while the rows hardcoded `None`
    // (`crates/freshell-terminal/src/registry.rs` `inventory()`;
    // `docs/plans/2026-07-19-state-sync-cartography.md` §1.4). Shell
    // terminals have no identity entry and stay unstamped.
    let mut terminals = state.registry.inventory();
    for terminal in &mut terminals {
        if terminal.session_ref.is_none() {
            terminal.session_ref = state.identity.session_ref_for(&terminal.terminal_id);
        }
    }
    messages.push(ServerMessage::TerminalInventory(TerminalInventory {
        boot_id,
        terminals,
        terminal_meta: Vec::new(),
    }));
    messages
}

/// Outcome of validating a `hello` frame. `Accept` carries no data; the reject
/// arms carry the error to surface to the client before closing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelloOutcome {
    Accept,
    /// Not a `hello` frame, or unparseable — the original closes NOT_AUTHENTICATED.
    NotHello,
    /// `protocolVersion != 7` — checked BEFORE the token (matches ws-handler.ts).
    ProtocolMismatch,
    /// Bad/missing token (constant-time compared).
    BadToken,
}

/// Validate a parsed `hello` payload against the auth contract, in the original's
/// order: it must be a `hello`, then `protocolVersion` must match, then the token
/// must pass a constant-time compare.
pub fn evaluate_hello(value: &serde_json::Value, expected_token: &str) -> HelloOutcome {
    if value.get("type").and_then(|v| v.as_str()) != Some("hello") {
        return HelloOutcome::NotHello;
    }
    // protocolVersion FIRST — a mismatch is reported before we ever look at auth.
    if value.get("protocolVersion").and_then(|v| v.as_u64()) != Some(WS_PROTOCOL_VERSION as u64) {
        return HelloOutcome::ProtocolMismatch;
    }
    let token = value.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if !constant_time_eq(token.as_bytes(), expected_token.as_bytes()) {
        return HelloOutcome::BadToken;
    }
    HelloOutcome::Accept
}

async fn handle_socket(
    mut socket: WebSocket,
    state: WsState,
    origin: Option<String>,
    host: Option<String>,
) {
    // SAFE-03 Origin policy: evaluated BEFORE the first frame is even read, so
    // a rejected connection observes zero session state (no ready/settings/
    // terminal.inventory) — just an error frame + close. See [`crate::origin`]
    // for why this is deliberate hardening beyond the (advisory-only) original.
    let origin_decision =
        crate::origin::evaluate_origin(origin.as_deref(), host.as_deref(), &state.allowed_origins);
    if origin_decision == crate::origin::OriginDecision::Rejected {
        let _ = send_error(&mut socket, ErrorCode::Unauthorized, "Origin not allowed").await;
        let _ = close_with(&mut socket, CLOSE_ORIGIN_REJECTED, "Origin not allowed").await;
        return;
    }
    // DIAG-01: the origin allowed-kind for the `ws.connection.established`
    // event `terminal::run` emits once this connection is authenticated
    // (Rejected already returned above, so only these two remain).
    let origin_kind = match origin_decision {
        crate::origin::OriginDecision::NoOrigin => "no_origin",
        crate::origin::OriginDecision::Allowed => "allowed",
        crate::origin::OriginDecision::Rejected => unreachable!("handled above"),
    };

    // Read the first client frame (the hello), skipping any control frames.
    // SAFE-05: bounded by `hello_timeout_ms` (`ws-handler.ts:1167-1171` --
    // `state.helloTimer = setTimeout(() => { if (!state.authenticated)
    // ws.close(CLOSE_CODES.HELLO_TIMEOUT, 'Hello timeout') }, helloTimeoutMs)`).
    // The original's timer starts the instant the connection opens and is
    // cleared only once a VALID hello authenticates it (`ws-handler.ts:1856`);
    // a connection that never sends anything, or that sends only control
    // frames forever, must still be reaped -- so the deadline wraps the whole
    // read-loop, not a single `recv()` call.
    let hello_deadline = std::time::Duration::from_millis(state.hello_timeout_ms.max(1));
    let first = match tokio::time::timeout(hello_deadline, async {
        loop {
            match socket.recv().await {
                Some(Ok(Message::Text(text))) => break Some(text),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                // Closed / binary / error before a hello — nothing to do.
                _ => break None,
            }
        }
    })
    .await
    {
        Ok(Some(text)) => text,
        Ok(None) => return,
        Err(_elapsed) => {
            // DIAG-01-style: no `connection_id` exists yet at this point (it's
            // minted by `terminal::run` only after a successful handshake), so
            // this logs without one -- matches the original, which likewise
            // has no per-connection identity to report until `hello` succeeds.
            tracing::warn!(reason = "hello_timeout", "ws.hello.rejected");
            let _ = close_with(&mut socket, CLOSE_HELLO_TIMEOUT, "Hello timeout").await;
            return;
        }
    };

    let value: serde_json::Value = match serde_json::from_str(first.as_str()) {
        Ok(v) => v,
        Err(_) => {
            let _ = send_error(&mut socket, ErrorCode::InvalidMessage, "Invalid JSON").await;
            return;
        }
    };

    // Subscribe to the broadcast bus BEFORE the handshake so a REST-driven broadcast
    // can never slip through the window between "authenticated" and "streaming" (the
    // oracle's capture socket must observe every fresh-agent broadcast).
    let bcast_rx = state.broadcast_tx.subscribe();

    match evaluate_hello(&value, &state.auth_token) {
        HelloOutcome::Accept => {}
        HelloOutcome::NotHello => {
            // DIAG-01: `reason` only -- a `NotHello` frame couldn't have
            // carried a valid token anyway, but we never touch the field.
            tracing::warn!(reason = "not_hello", "ws.hello.rejected");
            let _ = send_error(&mut socket, ErrorCode::NotAuthenticated, "Send hello first").await;
            let _ = close_with(&mut socket, CLOSE_NOT_AUTHENTICATED, "Invalid token").await;
            return;
        }
        HelloOutcome::ProtocolMismatch => {
            tracing::warn!(reason = "protocol_mismatch", "ws.hello.rejected");
            let msg =
                format!("Expected protocol version {WS_PROTOCOL_VERSION}. Please reload the page.");
            let _ = send_error(&mut socket, ErrorCode::ProtocolMismatch, &msg).await;
            // S3: the original closes with a real WS close frame (code 4010,
            // reason "Protocol version mismatch") \u2014 without it the client only
            // observes an abnormal 1006 closure.
            let _ = close_with(
                &mut socket,
                CLOSE_PROTOCOL_MISMATCH,
                "Protocol version mismatch",
            )
            .await;
            return;
        }
        HelloOutcome::BadToken => {
            // DIAG-01: `reason` only -- covers both a wrong AND a missing
            // token (both evaluate to `BadToken`); the presented value is
            // NEVER logged, whether it was right, wrong, or absent.
            tracing::warn!(reason = "bad_token", "ws.hello.rejected");
            let _ = send_error(&mut socket, ErrorCode::NotAuthenticated, "Invalid token").await;
            // S3: covers both a wrong AND a missing token (both evaluate to
            // `BadToken`) \u2014 the original closes 4001 "Invalid token" in both cases.
            let _ = close_with(&mut socket, CLOSE_NOT_AUTHENTICATED, "Invalid token").await;
            return;
        }
    }

    // Authenticated: emit the ordered handshake.
    for msg in build_handshake(&state) {
        let json = match serde_json::to_string(&msg) {
            Ok(json) => json,
            Err(_) => return,
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            return;
        }
    }

    // Capability negotiation (`ws-handler.ts:1846-1848`): the connection's
    // `hello.capabilities.terminalOutputBatchV1` gates whether its terminal output is
    // framed as `terminal.output.batch` (on) or legacy `terminal.output` (off, default).
    let terminal_output_batch_v1 = value
        .get("capabilities")
        .and_then(|c| c.get("terminalOutputBatchV1"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // `capabilities.uiScreenshotV1` (`ws-handler.ts:1846`) marks this socket as able
    // to answer a `screenshot.capture` command. `terminal::run` registers the
    // connection's id + direct sink for its lifetime, allowing restore to bind both
    // tab delivery and acknowledgement to this exact socket.
    let ui_screenshot_v1 = value
        .get("capabilities")
        .and_then(|c| c.get("uiScreenshotV1"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Handshake done: serve the terminal.* shell path (and fan out broadcast-bus
    // frames) until the client closes.
    terminal::run(
        socket,
        &state,
        bcast_rx,
        terminal_output_batch_v1,
        ui_screenshot_v1,
        origin_kind,
    )
    .await;
}

/// WS close codes (`ws-handler.ts`'s `CLOSE_CODES`). S3: the original always
/// follows an auth/protocol reject error frame with a real close frame carrying
/// one of these codes + a short reason; the port previously just dropped the
/// connection, which a client observes as an abnormal `1006` closure.
const CLOSE_NOT_AUTHENTICATED: u16 = 4001;
/// SAFE-05: `ws-handler.ts:255` `HELLO_TIMEOUT: 4002` -- a connection that
/// never completes `hello` within `hello_timeout_ms` is closed with this code.
const CLOSE_HELLO_TIMEOUT: u16 = 4002;
const CLOSE_PROTOCOL_MISMATCH: u16 = 4010;
/// SAFE-03: a NEW code (4011) -- the original has no Origin-rejection close
/// code at all (its Origin handling never rejects, see [`crate::origin`]), so
/// this doesn't collide with any of `server/ws-handler.ts`'s `CLOSE_CODES`
/// (4001/4002/4003/4008/4009/4010).
const CLOSE_ORIGIN_REJECTED: u16 = 4011;

/// Send a WS close frame with the given code/reason, best-effort (the socket
/// may already be gone).
async fn close_with(
    socket: &mut WebSocket,
    code: u16,
    reason: &'static str,
) -> Result<(), axum::Error> {
    use axum::extract::ws::CloseFrame;
    socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
}

/// Best-effort structured error (used only on the non-graded reject paths). The
/// happy path never sends an error; the client closes the socket itself.
async fn send_error(
    socket: &mut WebSocket,
    code: ErrorCode,
    message: &str,
) -> Result<(), axum::Error> {
    let msg = ServerMessage::Error(ErrorMsg {
        code,
        message: message.to_string(),
        timestamp: now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: None,
        terminal_exit_code: None,
        terminal_id: None,
    });
    match serde_json::to_string(&msg) {
        Ok(json) => socket.send(Message::Text(json.into())).await,
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_settings() -> ServerSettings {
        // Minimal but structurally valid; the exact default tree is pinned by
        // freshell-server's fixture test. Here we only need SOMETHING to emit.
        serde_json::from_value(json!({
            "ai": {},
            "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
            "editor": { "externalEditor": "auto" },
            "extensions": { "disabled": [] },
            "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
            "logging": { "debug": false },
            "network": { "configured": true, "host": "127.0.0.1" },
            "panes": { "defaultNewPane": "ask" },
            "safety": { "autoKillIdleMinutes": 15 },
            "sidebar": {
                "autoGenerateTitles": true,
                "excludeFirstChatMustStart": false,
                "excludeFirstChatSubstrings": []
            },
            "terminal": { "scrollback": 10000 }
        }))
        .unwrap()
    }

    fn state() -> WsState {
        let auth_token = Arc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        WsState {
            identity: crate::identity::TerminalIdentityRegistry::new(),
            auth_token: Arc::clone(&auth_token),
            server_instance_id: Arc::new("srv-1111".to_string()),
            boot_id: Arc::new("boot-2222".to_string()),
            settings: Arc::new(test_settings()),
            broadcast_tx: Arc::clone(&broadcast_tx),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, Arc::clone(&broadcast_tx)),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: Arc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: Arc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            config_fallback: None,
            amplifier_locator: None,
            opencode_locator: None,
            activity: None,
        }
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd")); // length mismatch
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn now_iso_is_iso8601_millis_z() {
        let ts = now_iso();
        // yyyy-mm-ddThh:mm:ss.mmmZ
        assert!(ts.contains('T'), "{ts}");
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn evaluate_hello_checks_version_before_token() {
        // Wrong version AND wrong token -> version wins (checked first).
        let v = json!({ "type": "hello", "protocolVersion": 6, "token": "nope" });
        assert_eq!(
            evaluate_hello(&v, "s3cr3t-token-abcdef"),
            HelloOutcome::ProtocolMismatch
        );

        // Right version, wrong token.
        let v = json!({ "type": "hello", "protocolVersion": 7, "token": "nope" });
        assert_eq!(
            evaluate_hello(&v, "s3cr3t-token-abcdef"),
            HelloOutcome::BadToken
        );

        // Right version, right token.
        let v = json!({ "type": "hello", "protocolVersion": 7, "token": "s3cr3t-token-abcdef" });
        assert_eq!(
            evaluate_hello(&v, "s3cr3t-token-abcdef"),
            HelloOutcome::Accept
        );

        // Not a hello.
        let v = json!({ "type": "ping" });
        assert_eq!(
            evaluate_hello(&v, "s3cr3t-token-abcdef"),
            HelloOutcome::NotHello
        );
    }

    #[test]
    fn handshake_is_ordered_with_shared_bootid() {
        let msgs = build_handshake(&state());
        let wire: Vec<serde_json::Value> = msgs
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();

        let types: Vec<&str> = wire.iter().map(|v| v["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            vec![
                "ready",
                "settings.updated",
                "perf.logging",
                "terminal.inventory"
            ]
        );

        // ready carries the boot-scoped ids + an ISO timestamp.
        assert_eq!(wire[0]["serverInstanceId"], "srv-1111");
        assert_eq!(wire[0]["bootId"], "boot-2222");
        assert!(wire[0]["timestamp"].as_str().unwrap().contains('T'));

        // perf.logging is disabled by default.
        assert_eq!(wire[2]["enabled"], json!(false));

        // terminal.inventory is empty and its bootId is BYTE-IDENTICAL to ready.
        assert_eq!(wire[3]["bootId"], wire[0]["bootId"]);
        assert_eq!(wire[3]["terminals"], json!([]));
        assert_eq!(wire[3]["terminalMeta"], json!([]));
    }

    /// GAP1 (CFG-03 checklist follow-up) RED/GREEN target: when boot fell
    /// back, `config.fallback` slots into the ordered handshake right after
    /// `perf.logging` and before `terminal.inventory` -- mirrors the
    /// original's exact ordering (`ws-handler.ts:1730-1735`).
    #[test]
    fn handshake_includes_config_fallback_when_boot_fell_back_and_in_correct_order() {
        let mut s = state();
        s.config_fallback = Some(freshell_protocol::ConfigFallback {
            reason: freshell_protocol::ConfigFallbackReason::ParseError,
            backup_exists: true,
        });
        let msgs = build_handshake(&s);
        let wire: Vec<serde_json::Value> = msgs
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        let types: Vec<&str> = wire.iter().map(|v| v["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            vec![
                "ready",
                "settings.updated",
                "perf.logging",
                "config.fallback",
                "terminal.inventory"
            ]
        );
        assert_eq!(wire[3]["reason"], "PARSE_ERROR");
        assert_eq!(wire[3]["backupExists"], true);
    }

    /// GAP1: a healthy boot (no fallback) must NOT inject a `config.fallback`
    /// frame at all -- the clean-boot handshake shape must stay byte-
    /// identical to before this fix (proves `handshake_is_ordered_with_
    /// shared_bootid` above, asserting the 4-message shape, keeps passing
    /// unchanged).
    #[test]
    fn handshake_omits_config_fallback_when_boot_was_healthy() {
        let msgs = build_handshake(&state());
        assert!(
            !msgs
                .iter()
                .any(|m| matches!(m, ServerMessage::ConfigFallback(_))),
            "a healthy boot must never emit a config.fallback frame"
        );
    }

    /// GAP1 late-connect delivery: `build_handshake` is called fresh on
    /// EVERY `/ws` connection (`handle_socket` -> `sendHandshakeSnapshot`
    /// equivalent), so a client that connects long after boot still
    /// receives the SAME notice as the first connection -- this is how the
    /// original achieves late-connect delivery too (per-connection
    /// `sendHandshakeSnapshot`, `ws-handler.ts:1723-1749`, recomputed on
    /// every hello rather than broadcast once at boot).
    #[test]
    fn handshake_delivers_config_fallback_identically_across_multiple_connections() {
        let mut s = state();
        s.config_fallback = Some(freshell_protocol::ConfigFallback {
            reason: freshell_protocol::ConfigFallbackReason::Enoent,
            backup_exists: false,
        });

        let first_connection = build_handshake(&s);
        // Simulate a client connecting much later: the SAME frozen WsState
        // (nothing mutates it between connections) produces an identical
        // handshake on a second, independent call.
        let late_connection = build_handshake(&s);

        assert_eq!(first_connection, late_connection);
        assert!(
            late_connection
                .iter()
                .any(|m| matches!(m, ServerMessage::ConfigFallback(_))),
            "a late-connecting client must still receive the config.fallback notice"
        );
    }

    // `spawn_periodic` (TERM-11 idle-reaper scheduling primitive): proves the
    // REAL tokio ticker cadence, decoupled from `enforce_idle_kills`' domain
    // logic (already exhaustively unit-tested in `freshell-terminal`).

    #[tokio::test(start_paused = true)]
    async fn spawn_periodic_invokes_callback_on_every_tick() {
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count2 = std::sync::Arc::clone(&count);
        spawn_periodic(std::time::Duration::from_millis(10), move || {
            count2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });

        // Paused tokio time: advance deterministically instead of sleeping wall
        // time. Five 10ms ticks elapse; `tokio::time::advance` also yields so
        // the spawned task actually runs between ticks.
        for _ in 0..5 {
            tokio::time::advance(std::time::Duration::from_millis(10)).await;
        }
        tokio::task::yield_now().await;

        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 5);
    }
}
