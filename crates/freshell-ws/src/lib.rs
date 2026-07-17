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

pub mod screenshot;
pub mod tabs;
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
    ErrorCode, ErrorMsg, PerfLogging, Ready, ServerMessage, ServerSettings, SettingsUpdated,
    TerminalInventory, WS_PROTOCOL_VERSION,
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
}

/// The `/ws` sub-router, pre-bound to its state (mergeable into the server app).
pub fn router(state: WsState) -> Router {
    Router::new().route("/ws", get(ws_handler)).with_state(state)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<WsState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
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
    vec![
        ServerMessage::Ready(Ready {
            timestamp: now_iso(),
            boot_id: Some(boot_id.clone()),
            server_instance_id: Some(state.server_instance_id.as_ref().clone()),
        }),
        ServerMessage::SettingsUpdated(SettingsUpdated {
            settings: state.settings.as_ref().clone(),
        }),
        ServerMessage::PerfLogging(PerfLogging { enabled: false }),
        ServerMessage::TerminalInventory(TerminalInventory {
            boot_id,
            terminals: state.registry.inventory(),
            terminal_meta: Vec::new(),
        }),
    ]
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

async fn handle_socket(mut socket: WebSocket, state: WsState) {
    // Read the first client frame (the hello), skipping any control frames.
    let first = loop {
        match socket.recv().await {
            Some(Ok(Message::Text(text))) => break text,
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
            // Closed / binary / error before a hello — nothing to do.
            _ => return,
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
            let _ = send_error(&mut socket, ErrorCode::NotAuthenticated, "Send hello first").await;
            let _ = close_with(&mut socket, CLOSE_NOT_AUTHENTICATED, "Invalid token").await;
            return;
        }
        HelloOutcome::ProtocolMismatch => {
            let msg = format!(
                "Expected protocol version {WS_PROTOCOL_VERSION}. Please reload the page."
            );
            let _ = send_error(&mut socket, ErrorCode::ProtocolMismatch, &msg).await;
            // S3: the original closes with a real WS close frame (code 4010,
            // reason "Protocol version mismatch") \u2014 without it the client only
            // observes an abnormal 1006 closure.
            let _ = close_with(&mut socket, CLOSE_PROTOCOL_MISMATCH, "Protocol version mismatch").await;
            return;
        }
        HelloOutcome::BadToken => {
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
    // to answer a `screenshot.capture` command. Count it for the life of the
    // connection so `POST /api/screenshots` knows a capable UI exists; decrement on
    // disconnect. The oracle's T0/T1 capture clients send no such capability, so this
    // stays a no-op on the graded paths.
    let ui_screenshot_v1 = value
        .get("capabilities")
        .and_then(|c| c.get("uiScreenshotV1"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if ui_screenshot_v1 {
        state.screenshots.add_capable_client();
    }

    // Handshake done: serve the terminal.* shell path (and fan out broadcast-bus
    // frames) until the client closes.
    terminal::run(socket, &state, bcast_rx, terminal_output_batch_v1).await;

    if ui_screenshot_v1 {
        state.screenshots.remove_capable_client();
    }
}

/// WS close codes (`ws-handler.ts`'s `CLOSE_CODES`). S3: the original always
/// follows an auth/protocol reject error frame with a real close frame carrying
/// one of these codes + a short reason; the port previously just dropped the
/// connection, which a client observes as an abnormal `1006` closure.
const CLOSE_NOT_AUTHENTICATED: u16 = 4001;
const CLOSE_PROTOCOL_MISMATCH: u16 = 4010;

/// Send a WS close frame with the given code/reason, best-effort (the socket
/// may already be gone).
async fn close_with(socket: &mut WebSocket, code: u16, reason: &'static str) -> Result<(), axum::Error> {
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
            cli_commands: Arc::new(Vec::new()),
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
        assert_eq!(evaluate_hello(&v, "s3cr3t-token-abcdef"), HelloOutcome::ProtocolMismatch);

        // Right version, wrong token.
        let v = json!({ "type": "hello", "protocolVersion": 7, "token": "nope" });
        assert_eq!(evaluate_hello(&v, "s3cr3t-token-abcdef"), HelloOutcome::BadToken);

        // Right version, right token.
        let v = json!({ "type": "hello", "protocolVersion": 7, "token": "s3cr3t-token-abcdef" });
        assert_eq!(evaluate_hello(&v, "s3cr3t-token-abcdef"), HelloOutcome::Accept);

        // Not a hello.
        let v = json!({ "type": "ping" });
        assert_eq!(evaluate_hello(&v, "s3cr3t-token-abcdef"), HelloOutcome::NotHello);
    }

    #[test]
    fn handshake_is_ordered_with_shared_bootid() {
        let msgs = build_handshake(&state());
        let wire: Vec<serde_json::Value> =
            msgs.iter().map(|m| serde_json::to_value(m).unwrap()).collect();

        let types: Vec<&str> = wire.iter().map(|v| v["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            vec!["ready", "settings.updated", "perf.logging", "terminal.inventory"]
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
}
