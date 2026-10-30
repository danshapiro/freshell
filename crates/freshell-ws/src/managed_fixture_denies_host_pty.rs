//! Real authenticated endpoint coverage. The finite controller below is a
//! routing fixture; genuine provider/Bun preparation is qualified by the owned
//! managed-environment browser target separately.
use super::*;
use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as ClientMessage;

struct SyntheticConfiguration {
    configuration: std::path::PathBuf,
    output: StdMutex<Option<String>>,
}

impl ManagedTerminalController for SyntheticConfiguration {
    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<
        'a,
        Result<ManagedTerminalDescriptor, freshell_terminal::registry::ManagedTerminalLaunchError>,
    > {
        Box::pin(async move {
            if request.mode != "opencode" {
                return Err("unexpected provider".into());
            }
            let consumed = tokio::process::Command::new("/bin/sh")
                .arg(&self.configuration)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .output()
                .await
                .map_err(|error| error.to_string())?;
            if !consumed.status.success() {
                return Err("synthetic configuration failed".into());
            }
            *self.output.lock().unwrap() =
                Some(String::from_utf8(consumed.stdout).map_err(|error| error.to_string())?);
            Ok(ManagedTerminalDescriptor {
                soul_id: "fixture-soul".into(),
                incarnation_id: "fixture-incarnation".into(),
                terminal_id: request.terminal_id,
                stream_id: request.stream_id,
                mode: request.mode,
                cwd: request.spec.cwd.unwrap_or_default(),
                resume_session_id: request.resume_session_id,
                create_request_id: request.create_request_id,
            })
        })
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), freshell_terminal::registry::ManagedTerminalInputError>>
    {
        Box::pin(async { Ok(()) })
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async { Err("this routing fixture does not serve replay".into()) })
    }
}

async fn create_over_socket(
    capabilities: Option<Value>,
    managed: bool,
) -> (Value, Vec<Value>, Option<String>) {
    let root = tempfile::tempdir().unwrap();
    let configuration = root.path().join("configuration.sh");
    std::fs::write(
        &configuration,
        "printf 'synthetic-configuration-consumed:%s' 'endpoint-nonce'\n",
    )
    .unwrap();
    let controller = Arc::new(SyntheticConfiguration {
        configuration,
        output: StdMutex::new(None),
    });
    let mut state = super::pane_reconcile_gate_tests::state();
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_managed_environment_fixture_only(true);
    state
        .registry
        .set_managed_controller(Some(controller.clone()));
    state.cli_commands = Arc::new(vec![freshell_platform::CliCommandSpec {
        name: "opencode".into(),
        label: "OpenCode".into(),
        default_cmd: "opencode".into(),
        ..Default::default()
    }]);
    let registry = state.registry.clone();
    let token = state.auth_token.to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::router(state))
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
    });
    let mut client = tokio_tungstenite::connect_async(url).await.unwrap().0;
    let observed = async {
        let mut hello = json!({"type":"hello","token":token,
            "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION});
        if let Some(capabilities) = capabilities {
            hello["capabilities"] = capabilities;
        }
        client
            .send(ClientMessage::Text(hello.to_string()))
            .await
            .map_err(|e| e.to_string())?;
        let mut handshake = vec![];
        for _ in 0..4 {
            let message = tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
                .await
                .map_err(|_| "hello timeout")?
                .ok_or("hello closed")?
                .map_err(|e| e.to_string())?;
            if let ClientMessage::Text(text) = message {
                handshake.push(serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?);
            }
        }
        client
            .send(ClientMessage::Text(
                json!({"type":"terminal.create",
            "requestId":"fixture-endpoint", "mode":if managed {"opencode"} else {"shell"},
            "shell":"system","cwd":root.path()})
                .to_string(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(10), client.next())
                .await
                .map_err(|_| "create timeout")?
                .ok_or("create closed")?
                .map_err(|e| e.to_string())?;
            if let ClientMessage::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if frame["type"] == "error" || frame["type"] == "terminal.created" {
                    return Ok::<_, String>((frame, handshake));
                }
            }
        }
    }
    .await;
    client.close(None).await.ok();
    drop(client);
    let rows = registry.directory();
    let row_observations: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({"terminalId":row.terminal_id,
        "managed":registry.is_managed(&row.terminal_id),"pid":registry.pid_of(&row.terminal_id)})
        })
        .collect();
    // RED can create an ordinary child. Reap only handles from this test's registry,
    // before any assertion, including the error/timeout path.
    for row in &rows {
        registry.kill(&row.terminal_id);
    }
    stop.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (frame, handshake) = observed.expect("authenticated endpoint completes");
    assert_eq!(handshake[0]["type"], "ready");
    let output = controller.output.lock().unwrap().clone();
    (frame, row_observations, output)
}

fn assert_denial(frame: Value, rows: Vec<Value>, output: Option<String>) {
    assert!(
        rows.is_empty(),
        "ordinary registry rows/PIDs must be absent: {rows:?}"
    );
    assert_eq!(frame["type"], "error", "{frame}");
    assert!(
        frame["message"]
            .as_str()
            .unwrap_or_default()
            .contains("managed environment fixture denies host PTY"),
        "{frame}"
    );
    assert!(
        output.is_none(),
        "unnegotiated requests must not launch managed either"
    );
}

#[tokio::test]
async fn legacy_ws() {
    let (frame, rows, output) = create_over_socket(None, false).await;
    assert_denial(frame, rows, output);
}

#[tokio::test]
async fn non_negotiated_ws() {
    let (frame, rows, output) =
        create_over_socket(Some(json!({"paneReconcileV1":true})), false).await;
    assert_denial(frame, rows, output);
}

#[tokio::test]
async fn managed_coding_still_works() {
    let (frame, rows, output) =
        create_over_socket(Some(json!({"managedRuntimeV1":true})), true).await;
    assert_eq!(frame["type"], "terminal.created", "{frame}");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["terminalId"], frame["terminalId"]);
    assert_eq!(rows[0]["managed"], true);
    assert!(rows[0]["pid"].is_null());
    assert_eq!(
        output.as_deref(),
        Some("synthetic-configuration-consumed:endpoint-nonce")
    );
}
