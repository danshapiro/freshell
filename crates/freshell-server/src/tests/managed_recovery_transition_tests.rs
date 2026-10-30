use super::*;
use freshell_runtime_protocol::*;
#[derive(Clone)]
pub(crate) struct CaptureLogs(pub(crate) Arc<std::sync::Mutex<Vec<serde_json::Value>>>);
#[derive(Default)]
struct Fields(serde_json::Map<String, serde_json::Value>);
impl tracing::field::Visit for Fields {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), format!("{value:?}").into());
    }
}
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureLogs {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        self.0.lock().unwrap().push(
            serde_json::json!({"severity":event.metadata().level().as_str(),"fields":fields.0}),
        );
    }
}

#[tokio::test]
async fn late_lookup_inventory_hydration_cannot_regress_live_recovery_or_block_input() {
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("stale-inventory.sock");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let soul = SoulId::new();
    let incarnation = IncarnationId::new();
    let blocked_view: RuntimeView = serde_json::from_value(serde_json::json!({
        "soulId": soul,
        "incarnationId": incarnation,
        "launchState": "running",
        "cleanupState": "none",
        "intentRevision": 4,
        "evidenceRevision": 7,
        "executionGeneration": 1,
        "terminalId": "stale-inventory-terminal",
        "terminalStreamId": "recovered-stream",
        "terminalMode": "opencode",
        "terminalCwd": "/workspace",
        "desiredState": "running",
        "recoveryState": "blocked",
        "recoveryReason": "dependency_unavailable"
    }))
    .unwrap();
    let mut live_view = blocked_view.clone();
    live_view.recovery_state = RecoveryState::Live;
    live_view.recovery_reason = None;

    let (inventory_started_tx, inventory_started_rx) = tokio::sync::oneshot::channel();
    let (release_inventory_tx, release_inventory_rx) = tokio::sync::oneshot::channel();
    let (input_tx, mut input_rx) = tokio::sync::mpsc::unbounded_channel();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
    let stale_inventory_view = blocked_view.clone();
    let server = tokio::spawn(async move {
        let mut inventory_started_tx = Some(inventory_started_tx);
        let mut release_inventory_rx = Some(release_inventory_rx);
        loop {
            let mut peer = tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => accepted.unwrap().0,
            };
            let request: Envelope<AdminCommand> = read_frame(&mut peer).await.unwrap();
            let request_id = request.request_id;
            match request.body {
                AdminCommand::Inventory => {
                    inventory_started_tx.take().unwrap().send(()).unwrap();
                    let release = release_inventory_rx.take().unwrap();
                    let view = stale_inventory_view.clone();
                    tokio::spawn(async move {
                        release.await.unwrap();
                        write_frame(
                            &mut peer,
                            &AdminReply {
                                request_id,
                                result: Ok(AdminResult::Inventory(vec![view])),
                            },
                        )
                        .await
                        .unwrap();
                    });
                }
                AdminCommand::Health => {
                    write_frame(
                        &mut peer,
                        &AdminReply {
                            request_id,
                            result: Ok(AdminResult::Health {
                                control_epoch: 1,
                                installation_id: InstallationId::new(),
                            }),
                        },
                    )
                    .await
                    .unwrap();
                }
                AdminCommand::TerminalInput(request) => {
                    input_tx.send(request.data).unwrap();
                    write_frame(
                        &mut peer,
                        &AdminReply {
                            request_id,
                            result: Ok(AdminResult::TerminalInput {
                                state: CommandState::Completed,
                            }),
                        },
                    )
                    .await
                    .unwrap();
                }
                other => panic!("unexpected managed runtime request: {other:?}"),
            }
        }
    });

    let controller = Arc::new(ServerManagedRuntimeController {
        client: RuntimeClient::new(&socket, "synthetic-stale-inventory-control"),
        recovery: Arc::default(),
    });
    controller.hydrate(blocked_view.clone()).await;
    let lookup_controller = controller.clone();
    let lookup = tokio::spawn(async move {
        lookup_controller
            .lookup_terminal("stale-inventory-terminal", None)
            .await
    });
    inventory_started_rx.await.unwrap();

    let completion = ManagedOutputCompletion {
        stream_epoch: "recovered-stream".into(),
        incarnation_id: incarnation.to_string(),
        head_seq: 23,
        exit_code: Some(42),
    };
    let sequence = controller
        .begin_recovery_observed(
            &soul,
            true,
            Some(RecoveryObservation {
                terminal_id: "stale-inventory-terminal".into(),
                incarnation_id: incarnation.to_string(),
                epoch: completion.stream_epoch.clone(),
                exit_code: completion.exit_code,
                completion: Some(completion.clone()),
            }),
        )
        .await
        .unwrap();
    let recovery_probe = RecoveryProbe::ReattachReady {
        handle: ReattachHandle {
            incarnation_id: incarnation.clone(),
            host_boot_id: HostBootId::new(),
            container_id: "a".repeat(64),
        },
        protocol_version: 1,
    };
    controller
        .publish_recovery(
            &soul,
            sequence,
            &Ok(RecoveryResult {
                outcome: RecoveryOutcome::Reattached,
                view: live_view,
                probe: Some(recovery_probe.clone()),
                prior_incarnation_id: None,
                attempt_id: None,
                expected_native_session_id: None,
                observed_native_session_id: None,
                incident_id: None,
            }),
        )
        .await;

    release_inventory_tx.send(()).unwrap();
    let terminal = lookup.await.unwrap().unwrap().unwrap();
    let lifecycle = controller.lifecycle_observation(&terminal).await.unwrap();
    assert_eq!(lifecycle.state, ManagedLifecycleState::Running);
    {
        let slots = controller.recovery.slots.lock().await;
        let slot = slots.get(soul.as_str()).unwrap();
        let published = slot.publication.result().unwrap();
        assert_eq!(published.outcome, RecoveryOutcome::Reattached);
        assert_eq!(published.view.recovery_state, RecoveryState::Live);
        assert_eq!(published.probe.as_ref(), Some(&recovery_probe));
        assert_eq!(slot.observed_epoch.as_deref(), Some("recovered-stream"));
        assert_eq!(slot.observed_exit_code, Some(42));
        assert_eq!(slot.observed_completion.as_ref(), Some(&completion));
    }

    controller
        .input(terminal, "input after recovery".into())
        .await
        .unwrap();
    assert_eq!(input_rx.recv().await.as_deref(), Some("input after recovery"));

    stop_tx.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn managed_runtime_recovery_transition_changes_cause_only_and_redacts_failed_payload() {
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;
    let bytes = Arc::new(std::sync::Mutex::new(vec![]));
    let capture = bytes.clone();
    let subscriber = tracing_subscriber::registry().with(CaptureLogs(capture));
    let (before_retry,soul)=async {
        let soul=SoulId::new();let incarnation=freshell_runtime_protocol::IncarnationId::new();
        let controller=ServerManagedRuntimeController {client:RuntimeClient::new("/unused-transition-fixture","synthetic"),recovery:Arc::default()};
        let mut view:RuntimeView=serde_json::from_value(serde_json::json!({"soulId":soul,"incarnationId":incarnation,
            "launchState":"running","cleanupState":"none","desiredState":"running","recoveryState":"blocked",
            "intentRevision":1,"executionGeneration":1,"terminalId":"transition-terminal","terminalStreamId":"actual-epoch",
            "terminalMode":"opencode","terminalCwd":"/workspace","recoveryReason":"ambiguous_identity",
            "incidentId":"incident-first","recoveryAttemptId":"recovery-first"})).unwrap();
        for _ in 0..40 {controller.hydrate(view.clone()).await;}
        view.incident_id=Some(freshell_runtime_protocol::IncidentId::parse("incident-second").unwrap());
        for _ in 0..40 {controller.hydrate(view.clone()).await;}
        let before_retry=bytes.lock().unwrap().len();
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime { code: RuntimeErrorCode::HostUnreachable, message: "raw secret=synthetic-sensitive-error".into(), diagnostic_code: None, fresh_agent_provider_start_diagnostic: None })).await;
        for _ in 0..40 {controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime { code: RuntimeErrorCode::HostUnreachable, message: "raw secret=synthetic-sensitive-error".into(), diagnostic_code: None, fresh_agent_provider_start_diagnostic: None })).await;}
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime { code: RuntimeErrorCode::InvalidRequest, message: "raw secret=synthetic-sensitive-error".into(), diagnostic_code: None, fresh_agent_provider_start_diagnostic: None })).await;
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        view.recovery_state=RecoveryState::Live;view.recovery_reason=None;
        controller.publish_recovery(&soul,sequence,&Ok(RecoveryResult {outcome:RecoveryOutcome::AlreadyLive,view,probe:None,
            prior_incarnation_id:None,attempt_id:None,expected_native_session_id:None,observed_native_session_id:None,incident_id:None})).await;
        (before_retry,soul)
    }.with_subscriber(subscriber).await;
    assert_eq!(
        before_retry, 1,
        "unchanged lifecycle and classified cause do not log metadata-only updates"
    );
    let events = bytes.lock().unwrap().clone();
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("synthetic-sensitive-error"));
    assert_eq!(events.len(), 7);
    for event in events {
        assert_eq!(
            event["fields"]["event"],
            "managed_runtime.recovery_transition"
        );
        assert_eq!(event["fields"]["soul_id"], soul.as_str());
        assert_eq!(event["fields"]["terminal_id"], "transition-terminal");
        for field in ["incarnation_id", "from", "to", "cause"] {
            assert!(!event["fields"][field].is_null());
        }
    }
}
