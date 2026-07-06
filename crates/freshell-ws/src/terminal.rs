//! Terminal-over-the-wire — the `terminal.*` dispatch of `server/ws-handler.ts`
//! (the `mode:'shell'` path only), wired to the shared
//! [`TerminalRegistry`](freshell_terminal::TerminalRegistry).
//!
//! ## Connection-independent terminals (Phase 3.12)
//!
//! Earlier steps owned a terminal on the connection that created it: its PTY and
//! output frames streamed to that one socket and were killed on socket close. That
//! fails every detach/attach/background-session flow — a *second* or *reconnected*
//! socket has nothing shared to re-attach to. This dispatch now resolves every
//! terminal through [`WsState::registry`], which owns terminals by `terminalId`
//! across all connections:
//!
//! ```text
//! terminal.create  -> registry.create() spawns + registers a running PTY (no attach)
//! terminal.attach  -> registry.attach(): attach.ready, replay scrollback, stream live
//! terminal.input   -> registry.input()  (pty.write; no wire reply)
//! terminal.resize  -> registry.resize()
//! terminal.detach  -> registry.detach() (PTY KEEPS RUNNING — background session)
//! terminal.kill    -> registry.kill()   (terminal.exit fanned out to every viewer)
//! socket close     -> registry.remove_connection() (all PTYs keep running)
//! ```
//!
//! ## Concurrency model
//!
//! One `tokio::select!` loop per connection. The connection owns a single mpsc
//! channel (`conn_rx`); a [`FrameSink`] wrapping its sender is what the registry
//! hands to `attach` — so `terminal.attach.ready`, the replayed scrollback, and the
//! live fan-out for THIS connection all arrive on the one channel, in strict seq
//! order (the registry enqueues the replay under the per-terminal lock before any
//! live frame). The loop drains `conn_rx` to the socket. The `attachRequestId`
//! stamping from 3.10 is preserved per-connection by the registry.
//!
//! ## Safety
//!
//! A socket close does NOT kill terminals (they are background sessions, reattachable
//! by a future socket). Every PTY is still reaped: `terminal.kill` reaps it, and the
//! registry — dropped on server shutdown — drops every [`PtyTerminal`], whose `Drop`
//! SIGKILLs + joins. No orphans.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use freshell_platform::detect::{host_os_live, is_wsl_env_live};
use freshell_platform::{build_spawn_spec, RealEnv, RealFileProbe, ShellType};
use freshell_protocol::{
    ClientMessage, ServerMessage, Shell, TerminalAttach, TerminalCreate, TerminalCreated,
    TerminalIdOnly, TerminalKill, TerminalResize,
};
use freshell_terminal::{build_child_env_from_process, FrameSink};

use crate::WsState;

/// The write half of a split axum WebSocket.
type WsSink = SplitSink<WebSocket, Message>;

/// Serialize + send one server→client message. Returns `false` if the socket is
/// closed/errored (the caller then tears the connection down).
async fn send(ws_tx: &mut WsSink, msg: &ServerMessage) -> bool {
    match serde_json::to_string(msg) {
        Ok(json) => ws_tx.send(Message::Text(json.into())).await.is_ok(),
        Err(_) => false,
    }
}

/// `Date.now()` — epoch milliseconds (`terminal.created.createdAt`).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Map the protocol `shell` enum to the platform `ShellType`.
fn map_shell(shell: Shell) -> ShellType {
    match shell {
        Shell::System => ShellType::System,
        Shell::Cmd => ShellType::Cmd,
        Shell::Powershell => ShellType::Powershell,
        Shell::Wsl => ShellType::Wsl,
    }
}

/// Serve one authenticated connection's `terminal.*` traffic (and fan out the
/// shared broadcast bus) until the socket closes. `socket` has already had the
/// connect handshake written by the caller; `bcast_rx` is this connection's
/// subscription to the server→client broadcast bus.
pub async fn run(
    socket: WebSocket,
    state: &WsState,
    mut bcast_rx: tokio::sync::broadcast::Receiver<String>,
    terminal_output_batch_v1: bool,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Identify this connection so the registry can key its terminal subscriptions
    // (and sweep them on close).
    let conn_id = state.registry.new_connection_id();

    // This connection's single outbound channel. The registry delivers this
    // connection's attach.ready / replay / live-output / exit frames here (via the
    // FrameSink below); the loop drains it to the socket in FIFO — hence in-order.
    let (conn_tx, mut conn_rx) = mpsc::unbounded_channel::<ServerMessage>();
    let conn_sink: FrameSink = {
        let tx = conn_tx.clone();
        Arc::new(move |msg| {
            let _ = tx.send(msg);
        })
    };

    // Whether the broadcast bus is still open (guards the select branch so a closed
    // bus can never busy-loop). The bus outlives every connection in practice.
    let mut bus_open = true;

    loop {
        tokio::select! {
            inbound = ws_rx.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_client_text(
                            text.as_str(),
                            &mut ws_tx,
                            state,
                            conn_id,
                            &conn_sink,
                            terminal_output_batch_v1,
                        )
                        .await
                        {
                            break;
                        }
                    }
                    // Client closed, socket error, or stream ended: tear down.
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // Binary / ping / pong: ignored (ping/pong handled by the transport).
                    _ => {}
                }
            }
            maybe_out = conn_rx.recv() => {
                if let Some(out) = maybe_out {
                    // A terminal frame destined for THIS connection (registry fan-out).
                    if !send(&mut ws_tx, &out).await {
                        break;
                    }
                }
            }
            frame = bcast_rx.recv(), if bus_open => {
                match frame {
                    // A pre-serialized server→client frame — forward it verbatim.
                    Ok(json) => {
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    // Slow consumer dropped some frames: the broadcast set is tiny and
                    // paced, so this is not expected; skip the gap and keep serving.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    // Sender gone (server shutting down): stop polling the bus.
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        bus_open = false;
                    }
                }
            }
        }
    }

    // Teardown: drop this connection's subscriptions. Terminals KEEP RUNNING as
    // background sessions — a future socket re-attaches. (PTYs are reaped by
    // terminal.kill or, on shutdown, the registry's Drop.)
    state.registry.remove_connection(conn_id);
}

/// Parse + dispatch one inbound client text frame. Returns `false` to close the
/// connection (only on an unrecoverable send failure).
async fn handle_client_text(
    text: &str,
    ws_tx: &mut WsSink,
    state: &WsState,
    conn_id: u64,
    conn_sink: &FrameSink,
    terminal_output_batch_v1: bool,
) -> bool {
    // Accept-and-strip: unknown/unparseable frames are ignored (matches the
    // runtime's tolerance; the handshake already gated auth).
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return true;
    };

    // The `tabs.sync.*` family is carried as opaque envelopes (its records aren't
    // in the typed `ClientMessage` enum), so dispatch it from the raw JSON before
    // the typed parse — mirrors the dedicated `case 'tabs.sync.*'` arms in
    // `server/ws-handler.ts:3058-3145`.
    if let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) {
        match msg_type {
            "tabs.sync.push" => return handle_tabs_push(&value, ws_tx, state).await,
            "tabs.sync.query" => return handle_tabs_query(&value, ws_tx, state).await,
            "tabs.sync.client.retire" => {
                handle_tabs_retire(&value, state);
                return true;
            }
            _ => {}
        }
    }

    let Ok(message) = serde_json::from_value::<ClientMessage>(value) else {
        return true;
    };
    match message {
        ClientMessage::TerminalCreate(create) => handle_create(create, ws_tx, state).await,
        ClientMessage::TerminalAttach(attach) => {
            handle_attach(attach, state, conn_id, conn_sink, terminal_output_batch_v1);
            true
        }
        ClientMessage::TerminalInput(input) => {
            state.registry.input(&input.terminal_id, input.data.as_bytes());
            true
        }
        ClientMessage::TerminalResize(resize) => {
            handle_resize(resize, state);
            true
        }
        ClientMessage::TerminalDetach(detach) => {
            handle_detach(&detach.terminal_id, ws_tx, state, conn_id).await
        }
        ClientMessage::TerminalKill(kill) => {
            handle_kill(kill, state);
            true
        }
        // freshAgent.create / freshAgent.send (codex + claude slices): dispatch to the
        // shared provider state as a DETACHED task so the cold sidecar spawn + the live
        // turn never block this connection's select loop (which must keep fanning out
        // the broadcast bus so the provider `freshAgent.*` frames reach the client).
        // The create gate is the SHARED `settings.freshAgent.enabled` flag.
        ClientMessage::FreshAgentCreate(create) => {
            if state.fresh_codex.is_enabled() {
                match create.provider {
                    Some(freshell_protocol::AgentProvider::Codex) => {
                        let fresh_codex = state.fresh_codex.clone();
                        tokio::spawn(async move { fresh_codex.handle_create(create).await });
                    }
                    Some(freshell_protocol::AgentProvider::Claude) => {
                        let fresh_claude = state.fresh_claude.clone();
                        tokio::spawn(async move { fresh_claude.handle_create(create).await });
                    }
                    _ => {}
                }
            }
            true
        }
        ClientMessage::FreshAgentSend(send) => {
            match send.provider {
                freshell_protocol::AgentProvider::Codex => {
                    let fresh_codex = state.fresh_codex.clone();
                    tokio::spawn(async move { fresh_codex.handle_send(send).await });
                }
                freshell_protocol::AgentProvider::Claude => {
                    let fresh_claude = state.fresh_claude.clone();
                    tokio::spawn(async move { fresh_claude.handle_send(send).await });
                }
                _ => {}
            }
            true
        }
        // Everything else (opencode fresh-agent, activity lists, ui.*, ping) is out of
        // scope for this path; ignore.
        _ => true,
    }
}

/// `terminal.create` — spawn + register the PTY in the shared registry (owned by no
/// connection), then reply `terminal.created`. Create does NOT attach; the client
/// sends `terminal.attach` next.
async fn handle_create(create: TerminalCreate, ws_tx: &mut WsSink, state: &WsState) -> bool {
    // `terminalId` via UUID (nanoid-alphabet-compatible for the oracle validator);
    // `streamId` via UUIDv4 (the reference's randomUUID()).
    let terminal_id = Uuid::new_v4().simple().to_string();
    let stream_id = Uuid::new_v4().to_string();

    let shell = map_shell(create.shell);
    // buildTerminalBaseEnv carries FRESHELL_TERMINAL_ID (FRESHELL_URL/TOKEN are not
    // part of the PTY byte stream — the T1 goldens exclude them). Present for faith.
    let mut overrides = BTreeMap::new();
    overrides.insert("FRESHELL_TERMINAL_ID".to_string(), terminal_id.clone());

    // Spawn at the default geometry (`opts.cols||120`, `opts.rows||30`); the client
    // attaches then resizes to its viewport.
    let spec = build_spawn_spec(
        shell,
        host_os_live(),
        is_wsl_env_live(),
        create.cwd.as_deref(),
        &RealEnv,
        &RealFileProbe,
        &overrides,
        None,
        None,
    );
    let child_env = build_child_env_from_process(&spec);

    if let Err(err) =
        state
            .registry
            .create(&spec, &child_env, terminal_id.clone(), stream_id, None)
    {
        eprintln!("terminal.create: PTY spawn failed: {err}");
        return true; // reference would surface an error; T1 never hits this path
    }

    let created = ServerMessage::TerminalCreated(TerminalCreated {
        created_at: now_ms(),
        request_id: create.request_id,
        terminal_id,
        clear_codex_durability: None,
        // Echo the resolved cwd (`record.cwd`) when the shell spec carries one.
        cwd: spec.cwd.clone(),
        restore_error: None,
        session_ref: None,
    });
    send(ws_tx, &created).await
}

/// `terminal.attach` — resolve the terminal in the shared registry and attach THIS
/// connection to it: the registry enqueues `terminal.attach.ready`, replays the
/// scrollback (seq-ordered, stamped with this attach's id + `source:'replay'`), and
/// registers the connection so live output fans out — all onto `conn_sink`, which
/// the select loop drains to the socket. Attaching to an unknown terminal is a no-op
/// (the reference surfaces `INVALID_TERMINAL_ID`; the SPA recreates on its own).
fn handle_attach(
    attach: TerminalAttach,
    state: &WsState,
    conn_id: u64,
    conn_sink: &FrameSink,
    terminal_output_batch_v1: bool,
) {
    state.registry.attach(
        &attach.terminal_id,
        conn_id,
        Arc::clone(conn_sink),
        attach.attach_request_id.clone(),
        attach.since_seq.unwrap_or(0),
        terminal_output_batch_v1,
    );
}

/// `terminal.resize` — resize the shared PTY (`registry.resize`); no dedicated wire
/// reply. `unchanged` when the geometry already matches.
fn handle_resize(resize: TerminalResize, state: &WsState) {
    let cols = resize.cols.clamp(0, u16::MAX as i64) as u16;
    let rows = resize.rows.clamp(0, u16::MAX as i64) as u16;
    state.registry.resize(&resize.terminal_id, cols, rows);
}

/// `terminal.detach` — drop THIS connection's subscription (the terminal keeps
/// running as a background session); reply `terminal.detached`.
async fn handle_detach(
    terminal_id: &str,
    ws_tx: &mut WsSink,
    state: &WsState,
    conn_id: u64,
) -> bool {
    state.registry.detach(terminal_id, conn_id);
    let detached = ServerMessage::TerminalDetached(TerminalIdOnly {
        terminal_id: terminal_id.to_string(),
    });
    send(ws_tx, &detached).await
}

/// `terminal.kill` — SIGKILL + reap the shared PTY and remove it. The registry fans
/// `terminal.exit{exitCode:0}` out to every attached connection (including this one,
/// via `conn_sink`), so no direct reply is needed here.
fn handle_kill(kill: TerminalKill, state: &WsState) {
    state.registry.kill(&kill.terminal_id);
}

// ── tabs.sync.* (ws-handler.ts:3058-3145) ────────────────────────────────────

/// `tabs.sync.push` — replace this client's open snapshot in the shared tabs
/// registry, then reply `tabs.sync.ack`. On a stale/invalid revision the registry
/// returns `Err`, which we surface as an `error{code:INVALID_MESSAGE}` frame (the
/// original's `catch` arm; the SPA maps a `/tabs/i` error to its sync-error state).
async fn handle_tabs_push(value: &serde_json::Value, ws_tx: &mut WsSink, state: &WsState) -> bool {
    let device_id = value.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
    let device_label = value.get("deviceLabel").and_then(|v| v.as_str()).unwrap_or("");
    let client_instance_id = value
        .get("clientInstanceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let snapshot_revision = value
        .get("snapshotRevision")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let records = crate::tabs::envelope_records(value);

    match state.tabs.replace_client_snapshot(
        state.server_instance_id.as_str(),
        device_id,
        device_label,
        client_instance_id,
        snapshot_revision,
        records,
    ) {
        Ok(ack) => {
            let msg = ServerMessage::TabsSyncAck(freshell_protocol::TabsSyncAck {
                accepted: ack.accepted,
                open_records: ack.open_records,
                closed_records: ack.closed_records,
            });
            send(ws_tx, &msg).await
        }
        Err(message) => send_tabs_error(ws_tx, &message).await,
    }
}

/// `tabs.sync.query` — reply `tabs.sync.snapshot` with the merged cross-device view
/// for the asking `(deviceId, clientInstanceId)`, echoing the query's `requestId`
/// (the SPA drops a snapshot whose `requestId` isn't the latest in-flight one).
async fn handle_tabs_query(value: &serde_json::Value, ws_tx: &mut WsSink, state: &WsState) -> bool {
    let device_id = value.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
    let client_instance_id = value
        .get("clientInstanceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let request_id = value.get("requestId").and_then(|v| v.as_str()).unwrap_or("");

    let data = state.tabs.query(device_id, client_instance_id);
    let frame = serde_json::json!({
        "type": "tabs.sync.snapshot",
        "requestId": request_id,
        "data": data,
    });
    send_raw(ws_tx, &frame).await
}

/// `tabs.sync.client.retire` — drop this client's open snapshot (background retire;
/// no reply). The unload beacon also hits `POST /api/tabs-sync/client-retire`, which
/// routes to the same [`crate::tabs::TabsRegistry`], so the retire is idempotent.
fn handle_tabs_retire(value: &serde_json::Value, state: &WsState) {
    let device_id = value.get("deviceId").and_then(|v| v.as_str()).unwrap_or("");
    let client_instance_id = value
        .get("clientInstanceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let snapshot_revision = value
        .get("snapshotRevision")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    state
        .tabs
        .retire_client_snapshot(device_id, client_instance_id, snapshot_revision);
}

/// Send a raw JSON value as a text frame. Returns `false` if the socket is closed.
async fn send_raw(ws_tx: &mut WsSink, value: &serde_json::Value) -> bool {
    match serde_json::to_string(value) {
        Ok(json) => ws_tx.send(Message::Text(json.into())).await.is_ok(),
        Err(_) => false,
    }
}

/// Emit a minimal `error{code:INVALID_MESSAGE}` frame for a rejected tabs push.
async fn send_tabs_error(ws_tx: &mut WsSink, message: &str) -> bool {
    let frame = serde_json::json!({
        "type": "error",
        "code": "INVALID_MESSAGE",
        "message": message,
        "timestamp": crate::now_iso(),
    });
    send_raw(ws_tx, &frame).await
}
