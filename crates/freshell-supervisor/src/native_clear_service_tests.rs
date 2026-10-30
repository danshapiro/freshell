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
        }));
        let current = host.clone();
        let database = registry.database_path().to_owned();
        let boot = HostBootId::new();
        let epoch = registry.control_epoch();
        let native_launch = launch.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
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
                        let state = current.lock().unwrap();
                        Ok(HostResult::FreshAgentEvents(AgentEventBatch {
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
                            state: CommandState::ProviderAcked,
                            native_session_id: Some(state.root.clone()),
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
                write_frame(
                    &mut socket,
                    &HostReply {
                        request_id: envelope.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
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
