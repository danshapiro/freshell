async fn managed_socket_windows(
    final_head: i64,
    rounds: usize,
) -> Result<Vec<(String, usize)>, String> {
    use tokio_tungstenite::tungstenite::Message as ClientMessage;
    let state = super::pane_reconcile_gate_tests::state();
    let terminal = "T-managed-short-lived";
    state.registry.register_managed(ManagedTerminalDescriptor {
        soul_id: "soul-short-lived".into(),
        incarnation_id: "incarnation-short-lived".into(),
        terminal_id: terminal.into(),
        stream_id: "S-managed-short-lived".into(),
        mode: "opencode".into(),
        cwd: "/workspace".into(),
        resume_session_id: None,
        create_request_id: None,
    });
    state
        .registry
        .set_managed_controller(Some(Arc::new(ExitedOpenCodeRead {
            final_head,
            lifecycle: None,
            exit_code: Some(17),
            native_session_id: Some("ses-short-lived".into()),
        })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let token = state.auth_token.to_string();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::router(state))
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
    });
    let mut clients = vec![];
    for _ in 0..2 {
        clients.push(tokio_tungstenite::connect_async(&url).await.unwrap().0);
    }
    let observed = async {
        let mut windows = vec![];
        for round in 0..rounds {
            if round > 0 {
                for client in &mut clients {
                    client.close(None).await.ok();
                }
                clients.clear();
                for _ in 0..2 {
                    clients.push(
                        tokio_tungstenite::connect_async(&url)
                            .await
                            .map_err(|e| e.to_string())?
                            .0,
                    );
                }
            }
            for (index, client) in clients.iter_mut().enumerate() {
                client
                    .send(ClientMessage::Text(
                        serde_json::json!({"type":"hello","token":token,
                "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION})
                        .to_string(),
                    ))
                    .await
                    .map_err(|e| e.to_string())?;
                for _ in 0..4 {
                    tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
                        .await
                        .map_err(|_| "hello timeout")?
                        .ok_or("hello closed")?
                        .map_err(|e| e.to_string())?;
                }
                let attach = serde_json::json!({"type":"terminal.attach","terminalId":terminal,
                    "intent":"viewport_hydrate", "cols":80,"rows":24,"sinceSeq":0,
                    "attachRequestId":format!("reader-{index}")});
                serde_json::from_value::<freshell_protocol::ClientMessage>(attach.clone())
                    .map_err(|error| format!("invalid attach fixture: {error}"))?;
                client
                    .send(ClientMessage::Text(attach.to_string()))
                    .await
                    .map_err(|e| e.to_string())?;
            }
            for (reader, client) in clients.iter_mut().enumerate() {
                let mut data = String::new();
                let mut exits = 0;
                let mut received = vec![];
                loop {
                    let message =
                        tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
                            .await
                            .map_err(|_| {
                                format!("output timeout for reader {reader}; received {received:?}")
                            })?
                            .ok_or("output closed")?
                            .map_err(|e| e.to_string())?;
                    let ClientMessage::Text(text) = message else {
                        continue;
                    };
                    let frame: serde_json::Value =
                        serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    received.push(
                        serde_json::json!({"type":frame["type"],"terminalId":frame["terminalId"],
                    "code":frame["code"],"seqStart":frame["seqStart"],"seqEnd":frame["seqEnd"],
                    "bytes":frame["data"].as_str().map(str::len)}),
                    );
                    if frame["type"] == "error" {
                        return Err(format!("unexpected server error: {received:?}"));
                    }
                    if frame["terminalId"] != terminal {
                        continue;
                    }
                    match frame["type"].as_str() {
                        Some("terminal.output") | Some("terminal.snapshot") => {
                            data += frame["data"].as_str().unwrap_or_default()
                        }
                        Some("terminal.exit") => {
                            exits += 1;
                            if frame["managedRetained"] != true {
                                return Err("managed exit retired client identity".into());
                            }
                            break;
                        }
                        Some("error") => return Err(format!("unexpected {}", frame["code"])),
                        _ => {}
                    }
                }
                // Ping orders behind any duplicate exit already queued.
                client
                    .send(ClientMessage::Text("{\"type\":\"ping\"}".into()))
                    .await
                    .map_err(|e| e.to_string())?;
                loop {
                    let message =
                        tokio::time::timeout(std::time::Duration::from_secs(5), client.next())
                            .await
                            .map_err(|_| "pong timeout")?
                            .ok_or("pong closed")?
                            .map_err(|e| e.to_string())?;
                    let ClientMessage::Text(text) = message else {
                        continue;
                    };
                    let frame: serde_json::Value =
                        serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    if frame["type"] == "terminal.exit" {
                        exits += 1;
                    }
                    if frame["type"] == "pong" {
                        break;
                    }
                }
                windows.push((data, exits));
            }
        }
        Ok::<_, String>(windows)
    }
    .await;
    for client in &mut clients {
        client.close(None).await.ok();
    }
    drop(clients);
    stop.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    observed
}

#[tokio::test]
async fn managed_retained_final_tail_two_real_sockets_reconnect_with_one_exit_each() {
    let windows = managed_socket_windows(3, 1).await.unwrap();
    assert_eq!(windows[0].0, "x".repeat(3 * 65536));
    assert_eq!(windows[0].0, windows[1].0);
    assert_eq!(windows[0].1, 1);
    assert_eq!(windows[1].1, 1);
}

#[tokio::test]
async fn managed_retained_reconnect_after_final_preserves_two_reader_handles() {
    let windows = managed_socket_windows(3, 2).await.unwrap();
    assert_eq!(windows.len(), 4);
    for (data, exits) in windows {
        assert_eq!(data, "x".repeat(3 * 65536));
        assert_eq!(exits, 1);
    }
}
