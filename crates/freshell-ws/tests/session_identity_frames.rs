//! STATE-SYNC FIX 1 / Increment 2(a): server-authoritative session identity
//! on every terminal frame that names a `terminalId`.
//!
//! The state-sync cartography (`docs/plans/2026-07-19-state-sync-cartography.md`
//! §1.4, §5 weakness 3) proved the rust port's identity repair channels are
//! dead: `terminal.created` (`terminal.rs:1077`), `terminal.inventory`
//! (`registry.rs:258`), and `terminal.attach.ready` (`registry.rs:631`) all
//! hardcode `session_ref: None` even when the identity registry KNOWS the
//! terminal's provider/sessionId — so the frozen client's reconcile fold
//! (`src/App.tsx:946-985` → `reconcileTerminalSessionAssociation`) never fires
//! and an identity missed at create time is missed forever.
//!
//! These tests drive a REAL axum server + REAL tokio-tungstenite client (the
//! `keepalive.rs` harness convention) through the resume-create path and
//! assert the three frames carry the canonical `sessionRef` — and that shell
//! terminals are NEVER stamped.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
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
    })
}

/// A minimal always-present CLI spec (`/bin/sh` sleeper script) so a
/// `mode:"amplifier"` create genuinely spawns — the same recording-script
/// convention as `freshell-freshagent`'s Slice 3a tests, minus the argv file
/// (these tests assert on wire frames, not argv).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-identity-frames-sleeper-{name}-{}.sh",
        std::process::id()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexec sleep 30\n").expect("write sleeper script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    freshell_platform::CliCommandSpec {
        name: name.to_string(),
        label: format!("{name}-label"),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        // Required for the fresh-claude preallocation path: `LaunchIntent::Start`
        // THROWS without `create_session_args` (`cli_launch.rs:436-441`), same
        // shape as the real claude spec (`cli_launch_goldens.rs:50`).
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Real axum server on an ephemeral loopback port, with an `amplifier` CLI
/// spec registered so resume creates spawn a real (sleeper) PTY. Returns the
/// ws URL + the shared registry (for cleanup kills).
async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": false } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![
            sleeper_cli_spec("amplifier"),
            sleeper_cli_spec("claude"),
        ]),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, returning the socket AND the parsed `terminal.inventory`
/// handshake frame (the 4th handshake message; `config_fallback` is None in
/// this harness, so the handshake is exactly 4 frames).
async fn connect_and_capture_inventory(url: &str) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    let mut inventory = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("terminal.inventory") {
                inventory = value;
            }
        }
    }
    assert!(
        !inventory.is_null(),
        "handshake must contain terminal.inventory"
    );
    (ws, inventory)
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 20 messages");
}

/// Non-null `sessionRef` accessor (robust to both omitted-key and explicit
/// null serializations).
fn session_ref_of(frame: &serde_json::Value) -> Option<serde_json::Value> {
    match frame.get("sessionRef") {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => None,
    }
}

/// **RED for increment 2(a)**: a RESUME-created coding-CLI terminal's
/// `terminal.created`, `terminal.attach.ready`, and (reconnect-time)
/// `terminal.inventory` frames must all carry the canonical
/// `sessionRef {provider: mode, sessionId: resumeSessionId}` — the identity
/// the WS create path already stamps into the identity registry
/// (`terminal.rs`'s `terminal_meta_record_for_create` → `identity.upsert`)
/// but never put on these frames.
#[tokio::test]
async fn resume_created_terminal_frames_carry_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-identity-1",
            "mode": "amplifier",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": "sess-identity-1",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let expected_ref =
        serde_json::json!({ "provider": "amplifier", "sessionId": "sess-identity-1" });
    assert_eq!(
        session_ref_of(&created),
        Some(expected_ref.clone()),
        "terminal.created must carry the create-time resume identity: {created}"
    );

    // attach.ready carries it too (the reconnect/viewport-hydrate repair path).
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 120,
            "rows": 30,
            "attachRequestId": "att-identity-1",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach");
    let ready = next_frame_of_type(&mut ws, "terminal.attach.ready").await;
    assert_eq!(
        session_ref_of(&ready),
        Some(expected_ref.clone()),
        "terminal.attach.ready must carry the identity: {ready}"
    );

    // A SECOND connection's handshake inventory row carries it (the
    // reconnect reconcile loop, App.tsx:976-985 — dead against the rust
    // server until now).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        Some(expected_ref),
        "terminal.inventory row must carry the identity: {row}"
    );

    registry.kill(&terminal_id);
}

/// A FRESH `claude` terminal create (no `resumeSessionId`, no `sessionRef`,
/// no restore) takes the server-preallocation path (`terminal.rs:776-789`:
/// fresh claude ALWAYS gets a server-preallocated `--session-id` UUID) — and
/// that preallocated identity must flow onto the wire: `terminal.created`
/// carries `sessionRef {provider:'claude', sessionId:<the preallocated UUID>}`
/// and a second connection's `terminal.inventory` row carries the same ref.
/// Pins the (previously unpinned) wire-behavior change from the identity
/// stamping commit: preallocation used to be argv-only.
#[tokio::test]
async fn fresh_claude_create_frames_carry_preallocated_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-fresh-claude-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let session_ref = session_ref_of(&created).unwrap_or_else(|| {
        panic!("fresh claude terminal.created must carry sessionRef: {created}")
    });
    assert_eq!(
        session_ref["provider"],
        serde_json::json!("claude"),
        "provider must be claude: {created}"
    );
    let session_id = session_ref["sessionId"]
        .as_str()
        .expect("sessionId string")
        .to_string();
    // The preallocated id is a randomUUID() (`ws:969-975` parity) — canonical
    // hyphenated UUID shape, NOT anything the client sent (it sent nothing).
    assert_eq!(
        session_id.len(),
        36,
        "preallocated UUID shape: {session_id}"
    );
    assert_eq!(
        session_id.chars().filter(|c| *c == '-').count(),
        4,
        "preallocated UUID shape: {session_id}"
    );

    // A SECOND connection's handshake inventory row carries the SAME ref.
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        Some(serde_json::json!({ "provider": "claude", "sessionId": session_id })),
        "terminal.inventory row must carry the preallocated identity: {row}"
    );

    registry.kill(&terminal_id);
}

/// Shell terminals are NEVER stamped: no provider identity exists (the
/// identity registry is only seeded for non-shell creates with a session id).
#[tokio::test]
async fn shell_terminal_frames_never_carry_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-shell-1",
            "mode": "shell",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(
        session_ref_of(&created),
        None,
        "a shell terminal.created must not carry a sessionRef: {created}"
    );

    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        None,
        "a shell inventory row must not carry a sessionRef: {row}"
    );

    registry.kill(&terminal_id);
}
