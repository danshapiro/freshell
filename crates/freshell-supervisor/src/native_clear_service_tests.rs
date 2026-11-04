//! Fresh-agent journal replay may publish a verified current Claude clear,
//! while an old Started row remains readable without changing live identity.

use super::{default_backend, Supervisor, SupervisorConfig};
use crate::registry::{OwnedRuntimeHandle, Registry};
use freshell_runtime_protocol::*;
use std::sync::{Arc, Mutex};
use tokio::net::UnixListener;

const PARENT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FORK: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTROL_SECRET: &str = "owned-clear-control-secret";

struct CurrentHost {
    root: String,
    observation: Option<NativeIdentityObservation>,
    journal_root: String,
    clear_on_compact: bool,
    ended: bool,
    prepared: usize,
    wrong_root_on_prepare: bool,
    stop_on_prepare: bool,
    inputs: Vec<String>,
    interrupt_ids: Vec<Option<String>>,
    resolve_attempts: Vec<(String, Option<String>)>,
    rollback_requests: Vec<(
        String,
        FreshAgentRollbackDirection,
        FreshAgentRollbackMode,
        Option<String>,
    )>,
    events_read_count: usize,
    events_gate: Option<Arc<tokio::sync::Notify>>,
    events_started: Arc<tokio::sync::Notify>,
    retained_state: Option<serde_json::Value>,
}

struct Fixture {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    handle: OwnedRuntimeHandle,
    launch: NativeIdentityLaunch,
    host: Arc<Mutex<CurrentHost>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        // This path contains this fixture's randomly minted incarnation only.
        let _ = std::fs::remove_dir_all(self.handle.runtime_dir());
    }
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
                .await;
        registry
            .record_native_session(soul.clone(), prepared.incarnation_id.clone(), PARENT.into())
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let launch = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: 0,
                requested_native_session_id: Some(PARENT.into()),
            })
            .await
            .unwrap();
        let mut resume = crate::checkpoints::tests::spec("claude");
        resume.provider_session.provider_store_id = "fresh-store".into();
        resume.provider_session.native_session_id = PARENT.into();
        resume.checkpoint_revision = 4;
        rusqlite::Connection::open(registry.database_path())
            .unwrap()
            .execute(
                "UPDATE souls SET resume_spec=?2,checkpoint_revision=4,durability_state='checkpoint_captured',allocation_state='verified_durable' WHERE soul_id=?1",
                rusqlite::params![soul.as_str(), serde_json::to_string(&resume).unwrap()],
            )
            .unwrap();
        let handle = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .prior_handle;
        std::fs::create_dir_all(handle.runtime_dir()).unwrap();
        let host_secret = b"owned-clear-host-secret";
        std::fs::write(handle.runtime_dir().join("secret"), host_secret).unwrap();
        let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
        let host = Arc::new(Mutex::new(CurrentHost {
            root: CHILD.into(),
            observation: None,
            journal_root: CHILD.into(),
            clear_on_compact: false,
            ended: false,
            prepared: 0,
            wrong_root_on_prepare: false,
            stop_on_prepare: false,
            inputs: Vec::new(),
            interrupt_ids: Vec::new(),
            resolve_attempts: Vec::new(),
            rollback_requests: Vec::new(),
            events_read_count: 0,
            events_gate: None,
            events_started: Arc::new(tokio::sync::Notify::new()),
            retained_state: None,
        }));
        let current = host.clone();
        let database = registry.database_path().to_owned();
        let boot = HostBootId::new();
        let epoch = registry.control_epoch();
        let native_launch = launch.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let mut allow_disconnected_reply = false;
                let result = match envelope.body {
                    HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => Ok(HostResult::Hello {
                        host_boot_id: boot.clone(),
                        proof: host_proof(host_secret, &challenge, &boot, &incarnation_id),
                        capabilities: vec![
                            "native-identity-observation-v1".into(),
                            "fresh-agent-native-readiness-v1".into(),
                        ],
                        effective_limits: crate::checkpoints::tests::limits(),
                    }),
                    HostCommand::FreshAgentReadEvents { .. } => {
                        let (gate, started) = {
                            let mut state = current.lock().unwrap();
                            state.events_read_count += 1;
                            (state.events_gate.clone(), state.events_started.clone())
                        };
                        if let Some(gate) = gate {
                            allow_disconnected_reply = true;
                            started.notify_one();
                            gate.notified().await;
                        }
                        let state = current.lock().unwrap();
                        Ok(HostResult::FreshAgentEvents(AgentEventBatch {
                            retained_state: state.retained_state.clone(),
                            retained_from: 1,
                            head: 1,
                            reset_required: false,
                            events: vec![AgentJournalEvent {
                                sequence: 1,
                                event: AgentEvent::Started {
                                    native_session_id: state.journal_root.clone(),
                                },
                            }],
                        }))
                    }
                    HostCommand::FreshAgentCompact { .. } => {
                        let mut state = current.lock().unwrap();
                        assert!(
                            state.clear_on_compact,
                            "only the owned clear operation is authorized"
                        );
                        state.root = CHILD.into();
                        state.journal_root = CHILD.into();
                        state.observation = Some(NativeIdentityObservation {
                            native_session_id: CHILD.into(),
                            incarnation_id: native_launch.incarnation_id.clone(),
                            launch_nonce: native_launch.launch_nonce.clone(),
                            evidence_revision: native_launch.evidence_revision,
                            source: NativeIdentitySource::ClaudeNativeClear,
                            evidence_digest: "b".repeat(64),
                        });
                        Ok(HostResult::FreshAgentCommand {
                            native_identity: None,
                            state: CommandState::ProviderAcked,
                            native_session_id: Some(CHILD.into()),
                            claude_fork: None,
                        })
                    }
                    HostCommand::FreshAgentPrepareNative { .. } => {
                        let conn = rusqlite::Connection::open(&database).unwrap();
                        let journaled: u64 = conn
                            .query_row("SELECT count(*) FROM input_commands", [], |row| row.get(0))
                            .unwrap();
                        assert_eq!(journaled, 0, "native readiness precedes input admission");
                        let mut state = current.lock().unwrap();
                        state.prepared += 1;
                        state.ended = false;
                        let root = if state.wrong_root_on_prepare {
                            CHILD
                        } else {
                            PARENT
                        };
                        state.root = root.into();
                        state.observation = Some(NativeIdentityObservation {
                            native_session_id: root.into(),
                            incarnation_id: native_launch.incarnation_id.clone(),
                            launch_nonce: native_launch.launch_nonce.clone(),
                            evidence_revision: native_launch.evidence_revision,
                            source: NativeIdentitySource::FreshProviderHandshake,
                            evidence_digest: "a".repeat(64),
                        });
                        if state.stop_on_prepare {
                            conn.execute("UPDATE souls SET desired_state='stopped',intent_revision=intent_revision+1", []).unwrap();
                        }
                        Ok(HostResult::FreshAgentCommand {
                            native_identity: None,
                            state: CommandState::Completed,
                            native_session_id: Some(root.into()),
                            claude_fork: None,
                        })
                    }
                    HostCommand::FreshAgentSend { text, .. } => {
                        let mut state = current.lock().unwrap();
                        assert!(!state.ended);
                        state.inputs.push(text);
                        Ok(HostResult::FreshAgentCommand {
                            native_identity: None,
                            state: CommandState::ProviderAcked,
                            native_session_id: Some(state.root.clone()),
                            claude_fork: None,
                        })
                    }
                    command @ HostCommand::FreshAgentInterrupt { .. } => {
                        let wire = serde_json::to_value(command).unwrap();
                        current
                            .lock()
                            .unwrap()
                            .interrupt_ids
                            .push(wire["params"]["request_id"].as_str().map(str::to_owned));
                        Ok(HostResult::FreshAgentInterrupted)
                    }
                    HostCommand::FreshAgentResolve {
                        decision_id,
                        operation_attempt_id,
                        ..
                    } => {
                        current
                            .lock()
                            .unwrap()
                            .resolve_attempts
                            .push((decision_id, operation_attempt_id));
                        Ok(HostResult::FreshAgentCommand {
                            native_identity: None,
                            state: CommandState::Completed,
                            native_session_id: None,
                            claude_fork: None,
                        })
                    }
                    HostCommand::FreshAgentRollback {
                        request_id,
                        direction,
                        mode,
                        turn_id,
                        ..
                    } => {
                        current.lock().unwrap().rollback_requests.push((
                            request_id.as_str().to_owned(),
                            direction,
                            mode,
                            turn_id,
                        ));
                        Ok(HostResult::FreshAgentCommand {
                            native_identity: None,
                            state: CommandState::ProviderAcked,
                            native_session_id: None,
                            claude_fork: None,
                        })
                    }
                    HostCommand::Status { .. } => {
                        let state = current.lock().unwrap();
                        Ok(HostResult::Status {
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: epoch,
                            max_execution_generation: 0,
                            fixture_evidence: serde_json::Value::Null,
                            exited: state.ended,
                            native_session_id: (!state.ended).then(|| state.root.clone()),
                            native_identity_observation: state.observation.clone(),
                            opencode_transfer_receipt: None,
                            opencode_adoption: OpenCodeAdoptionStatus::NotRequired,
                        })
                    }
                    _ => Err(RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "owned native-store probe is unavailable",
                    )),
                };
                let write_result = write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: envelope.request_id,
                        result,
                    },
                )
                .await;
                if !allow_disconnected_reply {
                    write_result.unwrap();
                }
            }
        });
        std::fs::write(root.path().join("host"), b"owned host fixture").unwrap();
        let supervisor = Supervisor::new(
            registry,
            default_backend(
                root.path().join("absent-docker.sock"),
                root.path().join("lifecycle.jsonl"),
            ),
            SupervisorConfig {
                runtime_root: root.path().join("runtime"),
                control_socket_path: root.path().join("control.sock"),
                host_binary_path: root.path().join("host"),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                test_run_id: "owned-native-clear".into(),
                control_secret: CONTROL_SECRET.into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        Self {
            _root: root,
            supervisor,
            soul,
            handle,
            launch,
            host,
            task,
        }
    }

    async fn read_events(&self) {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentReadEvents(FreshAgentReadEventsRequest {
                soul_id: self.soul.clone(),
                after_sequence: 0,
                max_events: 16,
                expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
            }),
        );
        envelope.auth = Some(CONTROL_SECRET.into());
        let reply = self.supervisor.dispatch(envelope).await;
        assert!(
            matches!(reply.result, Ok(AdminResult::FreshAgentEvents(_))),
            "{:?}",
            reply.result
        );
    }
}

#[tokio::test]
async fn resolve_attempt_id_crosses_the_supervisor_and_legacy_requests_still_work() {
    let fixture = Fixture::new().await;
    {
        let mut host = fixture.host.lock().unwrap();
        host.root = PARENT.into();
        host.journal_root = PARENT.into();
        host.observation = Some(NativeIdentityObservation {
            native_session_id: PARENT.into(),
            incarnation_id: fixture.launch.incarnation_id.clone(),
            launch_nonce: fixture.launch.launch_nonce.clone(),
            evidence_revision: fixture.launch.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        });
    }
    for attempt in [None, Some("answer-attempt-2")] {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentResolve(FreshAgentResolveRequest {
                soul_id: fixture.soul.clone(),
                decision_id: "question-1".into(),
                decision: serde_json::json!({"answers":{"choice":"yes"}}),
                operation_attempt_id: attempt.map(str::to_owned),
                expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
            }),
        );
        envelope.auth = Some(CONTROL_SECRET.into());
        let reply = fixture.supervisor.dispatch(envelope).await;
        assert!(
            matches!(
                reply.result,
                Ok(AdminResult::FreshAgentCommand {
                    state: CommandState::Completed
                })
            ),
            "{:?}",
            reply.result
        );
    }
    assert_eq!(
        fixture.host.lock().unwrap().resolve_attempts,
        vec![
            ("question-1".into(), None),
            ("question-1".into(), Some("answer-attempt-2".into())),
        ]
    );
}

#[tokio::test]
async fn rollback_dispatch_preserves_the_owned_request_on_the_normal_stack() {
    let fixture = Fixture::new().await;
    let request_id = RequestId::parse("owned-rollback-request").unwrap();
    let mut envelope = Envelope::new(
        request_id,
        ControlRole::Web,
        AdminCommand::FreshAgentRollback(FreshAgentRollbackRequest {
            soul_id: fixture.soul.clone(),
            direction: FreshAgentRollbackDirection::Undo,
            mode: FreshAgentRollbackMode::ToTurn,
            turn_id: Some("owned-turn".into()),
            cwd: None,
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        }),
    );
    envelope.auth = Some(CONTROL_SECRET.into());
    let reply = fixture.supervisor.dispatch(envelope).await;
    assert!(
        matches!(
            reply.result,
            Ok(AdminResult::FreshAgentCommand {
                state: CommandState::ProviderAcked,
            })
        ),
        "{:?}",
        reply.result
    );
    assert_eq!(
        fixture.host.lock().unwrap().rollback_requests,
        vec![(
            "owned-rollback-request".to_owned(),
            FreshAgentRollbackDirection::Undo,
            FreshAgentRollbackMode::ToTurn,
            Some("owned-turn".to_owned()),
        )]
    );
}

#[tokio::test]
async fn stop_request_id_crosses_the_supervisor_and_legacy_stops_still_work() {
    let fixture = Fixture::new().await;
    for id in [Some("stop-from-browser"), None] {
        let mut params = serde_json::json!({
            "soulId": fixture.soul.as_str(),
            "expectedControlEpoch": fixture.supervisor.registry.control_epoch(),
        });
        if let Some(id) = id {
            params["requestId"] = serde_json::json!(id);
        }
        let command: AdminCommand = serde_json::from_value(serde_json::json!({
            "method": "fresh_agent_interrupt", "params": params,
        }))
        .unwrap();
        let mut envelope = Envelope::new(RequestId::new(), ControlRole::Web, command);
        envelope.auth = Some(CONTROL_SECRET.into());
        let reply = fixture.supervisor.dispatch(envelope).await;
        assert!(
            matches!(reply.result, Ok(AdminResult::FreshAgentInterrupted)),
            "{:?}",
            reply.result
        );
    }
    assert_eq!(
        fixture.host.lock().unwrap().interrupt_ids,
        vec![Some("stop-from-browser".into()), None]
    );
}

// Use the real control connection so the deadline must still release owned
// work after a web client drops its side of the request.
async fn start_retained_snapshot_request(
    fixture: &Fixture,
    max_duration_ms: u64,
) -> (tokio::task::JoinHandle<()>, tokio::io::DuplexStream) {
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let connection = tokio::spawn(super::serve_control_connection(
        fixture.supervisor.clone(),
        server,
    ));
    let request = serde_json::json!({
        "protocolVersion":CONTROL_PROTOCOL_VERSION,
        "requestId":RequestId::new(),
        "role":"web",
        "auth":CONTROL_SECRET,
        "body":{
            "method":"fresh_agent_read_retained_state",
            "params":{
                "soulId":fixture.soul.as_str(),
                "expectedControlEpoch":fixture.supervisor.registry.control_epoch(),
                "maxDurationMs":max_duration_ms
            }
        }
    });
    write_frame(&mut client, &request).await.unwrap();
    (connection, client)
}

#[tokio::test]
async fn retained_snapshot_request_deadline_cancels_waiting_lifecycle_lock_work() {
    use std::time::Duration;

    let fixture = Fixture::new().await;
    let lifecycle = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
    let held = lifecycle.lock().await;
    let mut requests = Vec::new();
    for _ in 0..3 {
        let (connection, client) = start_retained_snapshot_request(&fixture, 150).await;
        drop(client);
        requests.push(connection);
    }
    let expired_while_locked = tokio::time::timeout(Duration::from_secs(2), async {
        while requests.iter().any(|request| !request.is_finished()) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    drop(held);
    for request in requests {
        tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .expect("released request must finish")
            .expect("control connection must not panic");
    }
    let old_reads = fixture.host.lock().unwrap().events_read_count;
    fixture.read_events().await;
    let all_reads = fixture.host.lock().unwrap().events_read_count;

    assert!(
        expired_while_locked,
        "the deadline must cover waiting for the lifecycle lock"
    );
    assert_eq!(
        old_reads, 0,
        "expired requests must not run after the lock is released"
    );
    assert_eq!(all_reads, 1, "an ordinary events read must still run");
}

#[tokio::test]
async fn retained_snapshot_request_deadline_cancels_a_stalled_host_read() {
    use std::time::Duration;

    let fixture = Fixture::new().await;
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = {
        let mut host = fixture.host.lock().unwrap();
        host.events_gate = Some(gate.clone());
        host.events_started.clone()
    };
    let (connection, client) = start_retained_snapshot_request(&fixture, 150).await;
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), started.notified())
        .await
        .expect("the authenticated host must receive the retained read");
    let expired_while_stalled = tokio::time::timeout(Duration::from_secs(2), async {
        while !connection.is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    let lifecycle = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
    let lock_released = tokio::time::timeout(Duration::from_millis(300), async {
        let _guard = lifecycle.lock().await;
    })
    .await
    .is_ok();
    fixture.host.lock().unwrap().events_gate = None;
    gate.notify_one();
    tokio::time::timeout(Duration::from_secs(3), connection)
        .await
        .expect("released host request must finish")
        .expect("control connection must not panic");
    fixture.read_events().await;
    let reads = fixture.host.lock().unwrap().events_read_count;

    assert!(
        expired_while_stalled,
        "the deadline must cover the authenticated host read"
    );
    assert!(
        lock_released,
        "the cancelled read must release the lifecycle lock"
    );
    assert_eq!(
        reads, 2,
        "one retained and one ordinary read must reach the host"
    );
}

#[tokio::test]
async fn retained_snapshot_request_does_not_apply_started_journal_rows() {
    use std::time::Duration;

    let fixture = Fixture::new().await;
    let retained = serde_json::json!({"snapshot":{"threadId":PARENT,"turns":[]}});
    {
        let mut host = fixture.host.lock().unwrap();
        host.retained_state = Some(retained.clone());
        host.observation = Some(NativeIdentityObservation {
            native_session_id: CHILD.into(),
            incarnation_id: fixture.handle.incarnation_id().clone(),
            launch_nonce: fixture.launch.launch_nonce.clone(),
            evidence_revision: fixture.launch.evidence_revision,
            source: NativeIdentitySource::ClaudeNativeClear,
            evidence_digest: "a".repeat(64),
        });
    }
    let (connection, mut client) = start_retained_snapshot_request(&fixture, 1_500).await;
    let reply: AdminReply = tokio::time::timeout(Duration::from_secs(2), read_frame(&mut client))
        .await
        .expect("retained read must finish")
        .unwrap();
    connection.await.unwrap();
    let after_retained = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.read_events().await;
    let after_ordinary = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();

    assert_eq!(
        after_retained.native_session_id.as_deref(),
        Some(PARENT),
        "a retained read must not apply journal identity changes"
    );
    assert!(
        after_retained.resume_spec.is_some(),
        "a retained read must not retire the saved recovery checkpoint"
    );
    assert_eq!(
        after_ordinary.native_session_id.as_deref(),
        Some(CHILD),
        "ordinary journal reads must still adopt verified native clears"
    );
    let AdminResult::FreshAgentEvents(batch) = reply.result.unwrap() else {
        panic!("expected retained event batch")
    };
    assert_eq!(
        batch.retained_state.unwrap()["snapshot"],
        retained["snapshot"]
    );
    assert!(
        batch.events.is_empty(),
        "retained-only reads must not expose journal rows"
    );
}

#[tokio::test]
async fn fresh_agent_journal_adopts_only_current_proven_clear_and_keeps_historical_parent_passive()
{
    let fixture = Fixture::new().await;
    fixture.read_events().await;
    let registry = &fixture.supervisor.registry;
    let before = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(
        before.native_session_id.as_deref(),
        Some(PARENT),
        "public Started without native proof is provisional"
    );
    assert!(
        before.resume_spec.is_some(),
        "a provisional rekey leaves parent recovery intact"
    );
    fixture.host.lock().unwrap().observation = Some(NativeIdentityObservation {
        native_session_id: CHILD.into(),
        incarnation_id: fixture.handle.incarnation_id().clone(),
        launch_nonce: fixture.launch.launch_nonce.clone(),
        evidence_revision: fixture.launch.evidence_revision,
        source: NativeIdentitySource::ClaudeNativeClear,
        evidence_digest: "a".repeat(64),
    });
    fixture.read_events().await;
    let cleared = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(
        cleared.native_session_id.as_deref(),
        Some(CHILD),
        "the current authenticated native clear must be adopted"
    );
    assert_eq!(
        cleared.native_identity_launch.as_ref(),
        Some(&fixture.launch)
    );
    assert!(
        cleared.resume_spec.is_none(),
        "the old parent's saved resume cannot be reused"
    );
    assert_eq!(cleared.checkpoint_revision, 0);
    assert_eq!(
        cleared
            .fresh_agent
            .as_ref()
            .unwrap()
            .native_session_id
            .as_deref(),
        Some(CHILD)
    );

    registry
        .transition_native_session_fenced(
            fixture.soul.clone(),
            fixture.handle.incarnation_id().clone(),
            CHILD,
            FORK,
            cleared.write_fence(),
        )
        .await
        .unwrap();
    let forked = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    {
        let mut host = fixture.host.lock().unwrap();
        host.root = FORK.into();
        host.journal_root = PARENT.into();
        host.observation = None;
    }
    fixture.read_events().await;
    let replayed = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(
        replayed.native_session_id.as_deref(),
        Some(FORK),
        "retained parent history cannot roll back a committed fork"
    );
    assert_eq!(
        replayed.native_identity_launch,
        forked.native_identity_launch
    );
}

#[tokio::test]
async fn fresh_agent_compact_native_clear_keeps_current_producer_and_retires_parent_resume() {
    let fixture = Fixture::new().await;
    {
        let mut host = fixture.host.lock().unwrap();
        host.root = PARENT.into();
        host.journal_root = PARENT.into();
        host.clear_on_compact = true;
        host.observation = Some(NativeIdentityObservation {
            native_session_id: PARENT.into(),
            incarnation_id: fixture.launch.incarnation_id.clone(),
            launch_nonce: fixture.launch.launch_nonce.clone(),
            evidence_revision: fixture.launch.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        });
    }
    let mut request = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::FreshAgentCompact(FreshAgentCompactRequest {
            soul_id: fixture.soul.clone(),
            instructions: Some("owned actual native clear".into()),
            cwd: None,
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        }),
    );
    request.auth = Some(CONTROL_SECRET.into());
    let reply = fixture.supervisor.dispatch(request).await;
    assert!(
        matches!(
            reply.result,
            Ok(AdminResult::FreshAgentCommand {
                state: CommandState::ProviderAcked
            })
        ),
        "{:?}",
        reply.result
    );
    let current = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(current.native_session_id.as_deref(), Some(CHILD));
    assert_eq!(
        current.native_identity_launch.as_ref(),
        Some(&fixture.launch),
        "the operation's native clear keeps its actual current producer"
    );
    assert!(current.resume_spec.is_none());
    assert_eq!(current.checkpoint_revision, 0);
    assert_eq!(
        current
            .fresh_agent
            .as_ref()
            .unwrap()
            .native_session_id
            .as_deref(),
        Some(CHILD)
    );
}

#[tokio::test]
async fn explicit_send_prepares_ended_claude_before_admission_and_never_bypasses_root_or_stop() {
    for failure in [None, Some("wrong-root"), Some("stop")] {
        let fixture = Fixture::new().await;
        {
            let mut host = fixture.host.lock().unwrap();
            host.root = PARENT.into();
            host.journal_root = PARENT.into();
            host.ended = true;
            host.observation = None;
            host.wrong_root_on_prepare = failure == Some("wrong-root");
            host.stop_on_prepare = failure == Some("stop");
        }
        let request_id = RequestId::new();
        let mut request = Envelope::new(
            request_id.clone(),
            ControlRole::Web,
            AdminCommand::FreshAgentSend(FreshAgentSendRequest {
                soul_id: fixture.soul.clone(),
                text: "the original user input".into(),
                settings: None,
                checkpoint_logical_attempt_id: None,
                expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
            }),
        );
        request.auth = Some(CONTROL_SECRET.into());
        let first = fixture.supervisor.dispatch(request.clone()).await;
        if failure.is_none() {
            assert!(
                matches!(
                    first.result,
                    Ok(AdminResult::FreshAgentCommand {
                        state: CommandState::ProviderAcked
                    })
                ),
                "{:?}",
                first.result
            );
            let repeated = fixture.supervisor.dispatch(request).await;
            assert!(
                matches!(
                    repeated.result,
                    Ok(AdminResult::FreshAgentCommand {
                        state: CommandState::Completed
                    })
                ),
                "{:?}",
                repeated.result
            );
        } else {
            assert!(first.result.is_err(), "{failure:?} cannot admit user input");
        }
        let host = fixture.host.lock().unwrap();
        assert_eq!(
            host.prepared, 1,
            "{failure:?}: explicit operation runs one zero-message preparation"
        );
        assert_eq!(
            host.inputs,
            if failure.is_none() {
                vec!["the original user input"]
            } else {
                vec![]
            }
        );
        let journaled: u64 =
            rusqlite::Connection::open(fixture.supervisor.registry.database_path())
                .unwrap()
                .query_row("SELECT count(*) FROM input_commands", [], |row| row.get(0))
                .unwrap();
        assert_eq!(journaled, if failure.is_none() { 1 } else { 0 });
    }
}
