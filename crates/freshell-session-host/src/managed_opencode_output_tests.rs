use super::*;
use std::{
    future::Future,
    task::{Context, Waker},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A disposable loopback native API. It emits a complete turn in one SSE
/// chunk after the subscription ack, before the REST snapshot is requested.
/// This protects the loss-free subscribe-before-snapshot ordering too.
async fn native_api() -> (String, tokio::task::JoinHandle<()>) {
    native_api_with_snapshot_gate(None).await
}

async fn native_api_with_snapshot_gate(
    gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
) -> (String, tokio::task::JoinHandle<()>) {
    native_api_with_controls(gate, None).await
}

async fn native_api_with_controls(
    gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    close_stream: Option<Arc<tokio::sync::Notify>>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let gate = gate.clone();
            let close_stream = close_stream.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut chunk = [0u8; 1024];
                    let size = socket.read(&mut chunk).await.unwrap();
                    if size == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..size]);
                }
                let request = std::str::from_utf8(&request).unwrap();
                let path = request.split_whitespace().nth(1).unwrap();
                if path == "/session/status" {
                    if let Some((requested, release)) = gate {
                        requested.notify_one();
                        release.notified().await;
                    }
                }
                if path == "/event" {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                    for event in [
                        serde_json::json!({"type":"server.connected"}),
                        serde_json::json!({"type":"session.created","properties":{"info":{"id":"ses_native"}}}),
                        serde_json::json!({"type":"session.status","properties":{"sessionID":"ses_native","status":{"type":"busy"}}}),
                        serde_json::json!({"type":"message.part.delta","properties":{"sessionID":"ses_native","delta":"synthetic-body-must-not-cross"}}),
                        serde_json::json!({"type":"session.updated","properties":{"info":{"id":"ses_native","title":"synthetic-title-must-not-cross"}}}),
                        serde_json::json!({"type":"session.status","properties":{"sessionID":"ses_native","status":{"type":"idle"}}}),
                    ] {
                        socket
                            .write_all(format!("data: {event}\n\n").as_bytes())
                            .await
                            .unwrap();
                    }
                    // Exit when the relay drops its stream rather than leaving
                    // a parked synthetic server task after the test finishes.
                    let mut byte = [0u8; 1];
                    if let Some(close_stream) = close_stream {
                        tokio::select! {
                            _ = close_stream.notified() => {},
                            _ = socket.read(&mut byte) => {},
                        }
                    } else {
                        let _ = socket.read(&mut byte).await;
                    }
                    return;
                }
                let body = match path {
                    "/global/health" => r#"{"healthy":true,"version":"1.18.21"}"#,
                    "/session/status" => "{}",
                    "/permission" | "/question" => "[]",
                    "/session/ses_native" => r#"{"id":"ses_native"}"#,
                    _ => panic!("unexpected native API path"),
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
        }
    });
    (format!("http://{address}"), task)
}

#[tokio::test]
async fn managed_input_after_native_disconnect_fails_without_claiming_or_writing_bytes() {
    let owned = tempfile::tempdir().unwrap();
    let state_dir = owned.path().join("state");
    let launch = serde_json::from_value(serde_json::json!({
        "terminalId":"native-disconnect", "streamId":"native-disconnect", "mode":"shell",
        "program":"/usr/bin/cat", "args":[], "cwd":owned.path(), "workspacePath":owned.path(),
        "projectKey":"native-disconnect", "cols":80, "rows":24,
        "runAsUid":unsafe { libc::geteuid() }, "runAsGid":unsafe { libc::getegid() },
        "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
    }))
    .unwrap();
    let incarnation = IncarnationId::new();
    let mut hosted = HostedPty::spawn(
        &state_dir,
        incarnation.clone(),
        &launch,
        BTreeMap::new(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let close_stream = Arc::new(tokio::sync::Notify::new());
    let (endpoint, server) = native_api_with_controls(None, Some(close_stream.clone())).await;
    let relay = crate::opencode_activity::OpencodeActivityRelay::spawn(
        "native-disconnect".into(),
        state_dir.clone(),
        endpoint,
        hosted.exited.clone(),
        Arc::new(tokio::sync::Notify::new()),
    );
    let readiness = relay.input_readiness();
    hosted.opencode_activity = Some(relay);
    let terminal = tokio::sync::Mutex::new(Some(hosted));
    readiness.clone().wait().await.unwrap();
    close_stream.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while readiness.ensure_ready().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let request = RequestId::new();
    let error = write_hosted_input(&terminal, &request, "controlled-keybytes\n")
        .await
        .unwrap_err();
    let mut terminal = terminal.lock().await;
    let hosted = terminal.as_mut().unwrap();
    let claimed = hosted
        .commands
        .existing_disposition(&request, b"controlled-keybytes\n")
        .unwrap()
        .is_some();
    let output = hosted.read_output(incarnation, 0, 65536, None).unwrap();
    hosted.stop().await;
    server.abort();
    let lifecycle =
        std::fs::read_to_string(state_dir.join("host-lifecycle.jsonl")).unwrap_or_default();
    assert!(
        lifecycle
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|record| record["event"] == "managed_opencode.activity_input_refused"),
        "refused OpenCode input must leave a structured host diagnostic"
    );
    assert!(
        !lifecycle.contains("controlled-keybytes"),
        "diagnostics must not persist the user's input"
    );
    assert_eq!(
        error.diagnostic_code,
        Some(freshell_runtime_protocol::RuntimeDiagnosticCode::OpencodeActivityDisconnected)
    );
    assert!(
        !claimed,
        "disconnected input must remain undispatched and retryable"
    );
    assert!(
        output.frames.is_empty(),
        "no refused bytes may reach the PTY"
    );
}

#[tokio::test]
async fn managed_startup_input_waits_for_native_subscription_and_snapshot_then_writes_once() {
    let owned = tempfile::tempdir().unwrap();
    let state_dir = owned.path().join("state");
    let launch = serde_json::from_value(serde_json::json!({
        "terminalId":"native-input", "streamId":"native-input", "mode":"shell",
        "program":"/usr/bin/python3", "args":["-c", "import sys\nf=open('received-input', 'ab', buffering=0)\nfor line in sys.stdin.buffer: f.write(line)"],
        "cwd":owned.path(), "workspacePath":owned.path(), "projectKey":"native-input",
        "cols":80, "rows":24, "runAsUid":unsafe { libc::geteuid() }, "runAsGid":unsafe { libc::getegid() },
        "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
    })).unwrap();
    let mut hosted = HostedPty::spawn(
        &state_dir,
        IncarnationId::new(),
        &launch,
        BTreeMap::new(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let snapshot_requested = Arc::new(tokio::sync::Notify::new());
    let release_snapshot = Arc::new(tokio::sync::Notify::new());
    let (endpoint, server) =
        native_api_with_snapshot_gate(Some((snapshot_requested.clone(), release_snapshot.clone())))
            .await;
    hosted.opencode_activity = Some(crate::opencode_activity::OpencodeActivityRelay::spawn(
        "native-input".into(),
        state_dir,
        endpoint,
        hosted.exited.clone(),
        Arc::new(tokio::sync::Notify::new()),
    ));
    let terminal = Arc::new(tokio::sync::Mutex::new(Some(hosted)));
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        snapshot_requested.notified(),
    )
    .await
    .unwrap();
    let request = RequestId::new();
    let mut input = Box::pin(write_hosted_input(
        &terminal,
        &request,
        "controlled-keybytes\n",
    ));
    let not_dispatched = input
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending();
    let observed_before = std::fs::read(owned.path().join("received-input")).unwrap_or_default();
    release_snapshot.notify_one();
    if not_dispatched {
        input.await.unwrap();
    }
    let captured = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let bytes = std::fs::read(owned.path().join("received-input")).unwrap_or_default();
            if !bytes.is_empty() {
                break bytes;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    write_hosted_input(&terminal, &request, "controlled-keybytes\n")
        .await
        .unwrap();
    terminal.lock().await.as_mut().unwrap().stop().await;
    server.abort();
    assert!(
        not_dispatched,
        "input must remain pending until native snapshot acknowledgement"
    );
    assert!(
        observed_before.is_empty(),
        "no original keystrokes may reach the PTY before acknowledgement"
    );
    assert!(
        captured == b"controlled-keybytes\n",
        "the original bytes must be written exactly once after acknowledgement"
    );
    assert!(
        std::fs::read(owned.path().join("received-input")).unwrap() == b"controlled-keybytes\n",
        "retrying a completed request must not dispatch twice"
    );
}

#[tokio::test]
async fn managed_output_relays_native_turn_edges_without_terminal_bytes_or_provider_bodies() {
    use freshell_activity::opencode::{OpencodeLaneEvent, OpencodeStatus};
    let owned = tempfile::tempdir().unwrap();
    let state_dir = owned.path().join("state");
    let incarnation = IncarnationId::new();
    let launch = serde_json::from_value(serde_json::json!({
        "terminalId":"native-activity", "streamId":"native-activity", "mode":"shell",
        "program":"/usr/bin/cat", "args":[], "cwd":owned.path(), "workspacePath":owned.path(),
        "projectKey":"native-activity", "cols":80, "rows":24,
        "runAsUid":unsafe { libc::geteuid() }, "runAsGid":unsafe { libc::getegid() },
        "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
    }))
    .unwrap();
    let mut hosted = HostedPty::spawn(
        &state_dir,
        incarnation.clone(),
        &launch,
        BTreeMap::new(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let (endpoint, server) = native_api().await;
    hosted.opencode_activity = Some(crate::opencode_activity::OpencodeActivityRelay::spawn(
        "native-activity".into(),
        state_dir.clone(),
        endpoint,
        hosted.exited.clone(),
        Arc::new(tokio::sync::Notify::new()),
    ));
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let output = hosted
                .read_output(incarnation.clone(), 0, 65536, None)
                .unwrap();
            if output.opencode_activity.as_ref().is_some_and(|batch| {
                batch.events.iter().any(|entry| {
                    matches!(
                        &entry.event,
                        OpencodeLaneEvent::Status {
                            status: OpencodeStatus::Idle,
                            ..
                        }
                    )
                })
            }) {
                break output;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    hosted.stop().await;
    server.abort();
    let output = output.expect("native events must reach the hosted output boundary");
    let lifecycle =
        std::fs::read_to_string(state_dir.join("host-lifecycle.jsonl")).unwrap_or_default();
    assert!(
        lifecycle
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|record| record["event"] == "managed_opencode.activity_lane_started"),
        "OpenCode relay startup must leave a structured host diagnostic"
    );
    assert!(!lifecycle.contains("synthetic-body-must-not-cross"));
    assert!(!lifecycle.contains("synthetic-title-must-not-cross"));
    let wire = serde_json::to_vec(&output).unwrap();
    let roundtrip: RuntimeOutputBatch = serde_json::from_slice(&wire).unwrap();
    let native = roundtrip.opencode_activity.unwrap();
    native.validate().unwrap();
    assert!(native.events.iter().any(|entry| matches!(
        &entry.event,
        OpencodeLaneEvent::Status {
            status: OpencodeStatus::Busy,
            ..
        }
    )));
    assert!(
        roundtrip.frames.is_empty(),
        "native completion requires no PTY output"
    );
    let metadata = String::from_utf8(serde_json::to_vec(&native).unwrap()).unwrap();
    assert!(!metadata.contains("synthetic-body-must-not-cross"));
    assert!(!metadata.contains("synthetic-title-must-not-cross"));
}
