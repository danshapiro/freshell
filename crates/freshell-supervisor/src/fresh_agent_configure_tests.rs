//! The admin configure route against a real registry and an authenticated
//! fake session host on the incarnation's own socket.

use super::{uses_fresh_agent_command_budget, Supervisor, SupervisorConfig};
use crate::backend::{
    BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend,
};
use crate::registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry};
use freshell_runtime_protocol::*;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::net::UnixListener;

const SECRET: &str = "synthetic-control-secret";

/// The configure route never creates, inspects or stops a runtime.
struct NoBackend;

#[async_trait::async_trait]
impl RuntimeBackend for NoBackend {
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        unreachable!("configure must not create a runtime")
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("configure must not start a host")
    }
    async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
        unreachable!("configure must not inspect the runtime")
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        unreachable!("configure must not stop the runtime")
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("configure must not stop the runtime")
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        unreachable!("configure must not verify the runtime")
    }
    async fn list_known(
        &self,
        _: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        unreachable!("configure must not list runtimes")
    }
    async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
        unreachable!("configure must not read limits")
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("configure must not change the runtime")
    }
}

struct RunningFreshClaude {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    incarnation: IncarnationId,
    runtime_dir: std::path::PathBuf,
}

async fn running_fresh_claude() -> RunningFreshClaude {
    let root = tempfile::tempdir().unwrap();
    let workspace = std::fs::canonicalize(root.path()).unwrap();
    let registry = Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "claude".into(),
            provider_store_id: "fresh-store".into(),
            native_session_id: None,
            creation_seed_ref: "configure-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "configure-fixture".into(),
            requested_limits: crate::checkpoints::tests::limits(),
            profile: RuntimeProfile::Custom,
            project_key: "fixture".into(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(FreshAgentLaunchSpec {
                session_id: "fresh-session".into(),
                provider: FreshProvider::Claude,
                session_type: "freshclaude".into(),
                runtime_variant: "claude-agent-sdk".into(),
                provider_store_id: "fresh-store".into(),
                cwd: workspace.to_string_lossy().into_owned(),
                workspace_path: workspace.to_string_lossy().into_owned(),
                git_common_dir: None,
                run_as_uid: 65_534,
                run_as_gid: 0,
                model: Some("sonnet".into()),
                effort: Some("low".into()),
                permission_mode: Some("default".into()),
                sandbox: None,
                native_session_id: None,
                plugins: None,
                model_selection: None,
                session_ref: None,
                fixture_transport: None,
                provider_bootstrap_files: Vec::new(),
                provider_secret_references: Vec::new(),
                provider_launch_context: None,
            }),
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let runtime_dir = root.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    std::fs::write(runtime_dir.join("host"), b"synthetic-host").unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                launch_policy: Default::default(),
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                runtime_dir: runtime_dir.clone(),
                host_binary_path: runtime_dir.join("host"),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(
            prepared.incarnation_id.clone(),
            HostBootId::new(),
            crate::checkpoints::tests::limits(),
        )
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    let launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.as_str().into(),
            evidence_revision: current.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: Some("native-claude".into()),
        })
        .await
        .unwrap();
    registry
        .record_native_session(
            soul.clone(),
            prepared.incarnation_id.clone(),
            "native-claude".into(),
        )
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .record_native_identity_observation(
            soul.clone(),
            NativeIdentityObservation {
                native_session_id: "native-claude".into(),
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: launch.launch_nonce.clone(),
                evidence_revision: launch.evidence_revision,
                source: NativeIdentitySource::FreshProviderHandshake,
                evidence_digest: "a".repeat(64),
            },
            current.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();
    let supervisor = Supervisor::new(
        registry,
        Arc::new(NoBackend),
        SupervisorConfig {
            runtime_root: runtime_dir.clone(),
            control_socket_path: root.path().join("control.sock"),
            host_binary_path: runtime_dir.join("host"),
            image_ref: format!("sha256:{}", "b".repeat(64)),
            test_run_id: "fresh-agent-configure".into(),
            control_secret: SECRET.into(),
            lifecycle_log: root.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    RunningFreshClaude {
        _root: root,
        supervisor,
        soul,
        incarnation: prepared.incarnation_id,
        runtime_dir,
    }
}

/// An authenticated session host that records every command it is sent.
fn fake_host(
    runtime_dir: &std::path::Path,
) -> (Arc<StdMutex<Vec<HostCommand>>>, tokio::task::JoinHandle<()>) {
    let secret = b"synthetic-host-secret";
    std::fs::write(runtime_dir.join("secret"), secret).unwrap();
    let listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
    let boot = HostBootId::new();
    let received = Arc::new(StdMutex::new(Vec::new()));
    let log = Arc::clone(&received);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
            log.lock().unwrap().push(envelope.body.clone());
            let result = match envelope.body {
                HostCommand::Hello {
                    incarnation_id,
                    challenge,
                } => HostResult::Hello {
                    host_boot_id: boot.clone(),
                    proof: host_proof(secret, &challenge, &boot, &incarnation_id),
                    capabilities: vec![],
                    effective_limits: crate::checkpoints::tests::limits(),
                },
                HostCommand::FreshAgentConfigure { .. } => HostResult::FreshAgentCommand {
                    claude_fork: None,
                    state: CommandState::ProviderAcked,
                    native_session_id: Some("native-claude".into()),
                },
                other => panic!("configure sent an unexpected host command {other:?}"),
            };
            write_frame(
                &mut socket,
                &HostReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    (received, task)
}

fn configure_envelope(
    soul: &SoulId,
    request_id: &RequestId,
    expected_control_epoch: Option<u64>,
) -> Envelope<AdminCommand> {
    configure_envelope_with(soul, request_id, expected_control_epoch, opus_high())
}

fn configure_envelope_with(
    soul: &SoulId,
    request_id: &RequestId,
    expected_control_epoch: Option<u64>,
    settings: FreshAgentTurnSettings,
) -> Envelope<AdminCommand> {
    let mut envelope = Envelope::new(
        request_id.clone(),
        ControlRole::Web,
        AdminCommand::FreshAgentConfigure(FreshAgentConfigureRequest {
            soul_id: soul.clone(),
            settings,
            expected_control_epoch,
        }),
    );
    envelope.auth = Some(SECRET.into());
    envelope
}

fn opus_high() -> FreshAgentTurnSettings {
    FreshAgentTurnSettings {
        cwd: None,
        model: Some("opus".into()),
        effort: Some("high".into()),
        permission_mode: None,
        sandbox: None,
    }
}

#[tokio::test]
async fn admin_configure_routes_to_the_souls_host_and_updates_the_recovery_profile() {
    let fixture = running_fresh_claude().await;
    let (received, host) = fake_host(&fixture.runtime_dir);
    let request_id = RequestId::parse("configure-route-1").unwrap();
    let epoch = fixture.supervisor.registry.control_epoch();

    let reply = fixture
        .supervisor
        .dispatch(configure_envelope(&fixture.soul, &request_id, Some(epoch)))
        .await;
    host.abort();

    assert!(matches!(
        reply.result.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));
    let configures: Vec<HostCommand> = received
        .lock()
        .unwrap()
        .iter()
        .filter(|command| matches!(command, HostCommand::FreshAgentConfigure { .. }))
        .cloned()
        .collect();
    assert_eq!(configures.len(), 1, "exactly one host configure");
    let HostCommand::FreshAgentConfigure {
        incarnation_id,
        request_id: host_request_id,
        settings,
    } = &configures[0]
    else {
        unreachable!()
    };
    assert_eq!(incarnation_id, &fixture.incarnation);
    assert_eq!(host_request_id, &request_id);
    assert_eq!(settings, &opus_high());
    let recovered = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .fresh_agent
        .expect("fresh-agent recovery spec");
    assert_eq!(
        recovered.model.as_deref(),
        Some("opus"),
        "a recovered incarnation launches with the configured settings"
    );
    assert_eq!(recovered.effort.as_deref(), Some("high"));
    assert_eq!(recovered.permission_mode.as_deref(), Some("default"));
}

/// The model selector's Default thinking row arrives as a model change with
/// no effort, which Claude's live configure reads as "clear the effort". The
/// recovery profile must agree with the host actor, which follows the same
/// rule, or the next recovery refuses the soul as a different identity.
#[tokio::test]
async fn admin_configure_to_the_default_effort_clears_the_recovery_effort() {
    let fixture = running_fresh_claude().await;
    let (received, host) = fake_host(&fixture.runtime_dir);
    let epoch = fixture.supervisor.registry.control_epoch();

    let reply = fixture
        .supervisor
        .dispatch(configure_envelope_with(
            &fixture.soul,
            &RequestId::parse("configure-default-effort").unwrap(),
            Some(epoch),
            FreshAgentTurnSettings {
                model: Some("opus".into()),
                ..FreshAgentTurnSettings::default()
            },
        ))
        .await;
    host.abort();

    assert!(reply.result.is_ok(), "{:?}", reply.result);
    assert!(received
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, HostCommand::FreshAgentConfigure { .. })));
    let recovered = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .fresh_agent
        .unwrap();
    assert_eq!(recovered.model.as_deref(), Some("opus"));
    assert_eq!(
        recovered.effort, None,
        "the recovery profile ends on the provider's default effort"
    );
}

/// A session host that died after the registry last saw it running: its
/// socket still accepts, but the connection closes before any answer.
fn crashed_host(runtime_dir: &std::path::Path) -> tokio::task::JoinHandle<()> {
    std::fs::write(runtime_dir.join("secret"), b"synthetic-host-secret").unwrap();
    let listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            drop(socket);
        }
    })
}

/// A host that cannot be reached never sees the configure, so it never
/// saves it. The recovery record must not save it either: recovery
/// relaunches the soul from that record and refuses a host actor whose
/// saved profile differs from it.
#[tokio::test]
async fn admin_configure_for_an_unreachable_host_leaves_the_recovery_profile_alone() {
    let fixture = running_fresh_claude().await;
    let host = crashed_host(&fixture.runtime_dir);
    let epoch = fixture.supervisor.registry.control_epoch();

    let reply = fixture
        .supervisor
        .dispatch(configure_envelope(
            &fixture.soul,
            &RequestId::parse("configure-crashed-host").unwrap(),
            Some(epoch),
        ))
        .await;
    host.abort();

    assert!(reply.result.is_err(), "{:?}", reply.result);
    let recovered = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .fresh_agent
        .unwrap();
    assert_eq!(recovered.model.as_deref(), Some("sonnet"));
    assert_eq!(recovered.effort.as_deref(), Some("low"));
}

#[tokio::test]
async fn admin_configure_with_a_stale_epoch_is_refused_before_any_host_or_registry_change() {
    let fixture = running_fresh_claude().await;
    let (received, host) = fake_host(&fixture.runtime_dir);
    let stale = fixture.supervisor.registry.control_epoch() + 1;

    let reply = fixture
        .supervisor
        .dispatch(configure_envelope(
            &fixture.soul,
            &RequestId::parse("configure-stale").unwrap(),
            Some(stale),
        ))
        .await;
    host.abort();

    assert_eq!(
        reply.result.unwrap_err().code,
        RuntimeErrorCode::StaleControlEpoch
    );
    assert!(
        received.lock().unwrap().is_empty(),
        "the host is never contacted"
    );
    let recovered = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .fresh_agent
        .unwrap();
    assert_eq!(recovered.model.as_deref(), Some("sonnet"));
}

#[test]
fn host_configure_gets_the_fresh_agent_command_budget() {
    // Claude's live configure waits on its sidecar settings RPC, which can
    // take far longer than an ordinary control command.
    assert!(uses_fresh_agent_command_budget(
        &HostCommand::FreshAgentConfigure {
            incarnation_id: IncarnationId::new(),
            request_id: RequestId::new(),
            settings: opus_high(),
        }
    ));
    assert!(!uses_fresh_agent_command_budget(&HostCommand::Status {
        incarnation_id: IncarnationId::new(),
    }));
}
