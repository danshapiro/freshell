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
            terminals: Vec::new(),
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
            return;
        }
        HelloOutcome::ProtocolMismatch => {
            let msg = format!(
                "Expected protocol version {WS_PROTOCOL_VERSION}. Please reload the page."
            );
            let _ = send_error(&mut socket, ErrorCode::ProtocolMismatch, &msg).await;
            return;
        }
        HelloOutcome::BadToken => {
            let _ = send_error(&mut socket, ErrorCode::NotAuthenticated, "Invalid token").await;
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

    // Handshake done: serve the terminal.* shell path (and fan out broadcast-bus
    // frames) until the client closes.
    terminal::run(socket, &state, bcast_rx).await;
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
        WsState {
            auth_token: Arc::new("s3cr3t-token-abcdef".to_string()),
            server_instance_id: Arc::new("srv-1111".to_string()),
            boot_id: Arc::new("boot-2222".to_string()),
            settings: Arc::new(test_settings()),
            broadcast_tx: Arc::new(tokio::sync::broadcast::channel::<String>(16).0),
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
