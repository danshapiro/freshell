#[tokio::test]
async fn hosted_codex_stop_receipt_uses_the_control_request_id() {
    let mut fixture = native_codex_fixture(json!({})).await;
    let actor = FreshAgentHostActor::open(
        fixture.dir.path().join("owned-stop-actor"),
        fixture.profile.clone(),
        fixture.transport.clone(),
    )
    .await
    .unwrap();
    let host = crate::tests::test_host_state();
    let host_dir = host.state_dir.clone();
    *host.fresh_agent.lock().await = Some(actor.clone());

    for expected in [Some("stop-from-browser"), None] {
        let (mut socket, host_socket) = tokio::net::UnixStream::pair().unwrap();
        let host_task = tokio::spawn(crate::handle_connection(host_socket, host.clone()));
        let mut command = json!({
            "method": "fresh_agent_interrupt",
            "params": { "incarnation_id": host.incarnation_id },
        });
        if let Some(id) = expected {
            command["params"]["request_id"] = json!(id);
        }
        let command: freshell_runtime_protocol::HostCommand =
            serde_json::from_value(command).unwrap();
        freshell_runtime_protocol::write_frame(
            &mut socket,
            &crate::tests::authenticated_host_envelope(&host, command),
        )
        .await
        .unwrap();
        let response: freshell_runtime_protocol::HostReply =
            freshell_runtime_protocol::read_frame(&mut socket)
                .await
                .unwrap();
        assert!(matches!(
            response.result,
            Ok(freshell_runtime_protocol::HostResult::FreshAgentInterrupted)
        ));
        drop(socket);
        host_task.await.unwrap().unwrap();

        let receipt = tokio::time::timeout(
            Duration::from_millis(if expected.is_some() { 3000 } else { 250 }),
            async {
                loop {
                    let frame: Value =
                        serde_json::from_str(&fixture.diagnostic.recv().await.unwrap()).unwrap();
                    if frame["event"]["code"] == "CODEX_INTERRUPT_FAILED" {
                        break frame;
                    }
                }
            },
        )
        .await;
        match expected {
            Some(id) => {
                let receipt =
                    receipt.expect("the native error must reach the hosted receipt stream");
                assert_eq!(receipt["event"]["type"], "freshAgent.operation.error");
                assert_eq!(receipt["event"]["operationReceipt"], true);
                assert_eq!(receipt["event"]["requestId"], id);
                assert!(receipt["event"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("No active Codex turn"));
            }
            None => assert!(
                receipt.is_err(),
                "legacy Stop must keep its old top-level response"
            ),
        }
    }

    actor.stop().await.unwrap();
    std::fs::remove_dir_all(host_dir).unwrap();
}
