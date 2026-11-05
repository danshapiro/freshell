//! The admin configure route against a real registry and an authenticated
//! fake session host on the incarnation's own socket.

use super::{uses_fresh_agent_command_budget, Supervisor, SupervisorConfig};
use crate::backend::{
    BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend,
};
use crate::registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry};
use freshell_runtime_protocol::*;
use sha2::{Digest, Sha256};
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

struct RunningFreshAgent {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    incarnation: IncarnationId,
    runtime_dir: std::path::PathBuf,
}

async fn running_fresh_claude() -> RunningFreshAgent {
    running_fresh_provider(FreshProvider::Claude).await
}
async fn running_fresh_provider(provider: FreshProvider) -> RunningFreshAgent {
    running_fresh_provider_with_name(provider, None, "native-claude").await
}

async fn running_fresh_provider_with_name(
    provider: FreshProvider,
    naming_handle: Option<String>,
    initial_native_session_id: &str,
) -> RunningFreshAgent {
    let root = tempfile::tempdir().unwrap();
    let workspace = std::fs::canonicalize(root.path()).unwrap();
    let registry = Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: provider.as_str().into(),
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
                naming_handle,
                collaboration_mode: None,
                session_id: "fresh-session".into(),
                provider: provider.clone(),
                session_type: if provider == FreshProvider::Codex {
                    "freshcodex"
                } else {
                    "freshclaude"
                }
                .into(),
                runtime_variant: if provider == FreshProvider::Codex {
                    "codex-app-server"
                } else {
                    "claude-agent-sdk"
                }
                .into(),
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
    registry
        .record_native_session(
            soul.clone(),
            prepared.incarnation_id.clone(),
            initial_native_session_id.into(),
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
            requested_native_session_id: Some(initial_native_session_id.into()),
        })
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .record_native_identity_observation(
            soul.clone(),
            NativeIdentityObservation {
                native_session_id: initial_native_session_id.into(),
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
    RunningFreshAgent {
        _root: root,
        supervisor,
        soul,
        incarnation: prepared.incarnation_id,
        runtime_dir,
    }
}

struct PreparedCodexReplacement {
    fixture: RunningFreshAgent,
    prior_incarnation: IncarnationId,
    target_incarnation: IncarnationId,
    attempt_id: RecoveryAttemptId,
    prior_root: String,
    next_root: String,
    target_cwd: String,
    resume_spec: ResumeSpec,
    source_launch: NativeIdentityLaunch,
    authorization: NativeReadinessRecoveryAuthorization,
}

async fn prepared_codex_replacement() -> PreparedCodexReplacement {
    let fixture = running_fresh_provider_with_name(
        FreshProvider::Codex,
        Some("pending-before-recovery".into()),
        "native-before-recovery",
    )
    .await;
    let registry = &fixture.supervisor.registry;
    let prior_root = "native-before-recovery".to_string();
    let current = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let candidate = crate::resume_catalog::exact_resume_candidate(&current, None)
        .unwrap()
        .expect("Codex native identity produces an exact resume proof");
    let resume_spec = registry
        .store_verified_resume_spec(fixture.soul.clone(), candidate)
        .await
        .unwrap();
    let current = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(current.resume_spec.as_ref(), Some(&resume_spec));

    let start = registry
        .begin_recovery_fenced(
            fixture.soul.clone(),
            RecoveryTrigger::ProviderExit,
            RecoveryPath::NativeResume,
            current.write_fence(),
        )
        .await
        .unwrap();
    let prior_incarnation = start.context.prior_handle.incarnation_id().clone();
    let attempt_id = start.attempt_id.clone();
    registry
        .mark_stop_outcome(prior_incarnation.clone(), StopOutcome::VerifiedEmpty)
        .await
        .unwrap();

    let target_cwd = fixture
        ._root
        .path()
        .join("recovery-cwd")
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(&target_cwd).unwrap();
    let mut target_spec = start
        .context
        .fresh_agent
        .clone()
        .expect("fresh-agent recovery retains its current launch settings");
    target_spec.cwd = target_cwd.clone();
    target_spec.native_session_id = Some(prior_root.clone());
    target_spec.session_ref = Some(ProviderSessionReference {
        provider: FreshProvider::Codex.as_str().into(),
        session_id: prior_root.clone(),
    });
    let replacement = registry
        .prepare_replacement(
            start,
            None,
            Some(target_spec),
            Some(resume_spec.clone()),
            RecoveryPath::NativeResume,
        )
        .await
        .unwrap();
    assert_eq!(replacement.prior_incarnation_id, prior_incarnation);
    assert_eq!(replacement.attempt_id, attempt_id);

    let target_incarnation = replacement.prepared.incarnation_id.clone();
    let target_runtime_dir = fixture._root.path().join("replacement-runtime");
    std::fs::create_dir_all(&target_runtime_dir).unwrap();
    let target_host = target_runtime_dir.join("host");
    std::fs::write(&target_host, b"synthetic-replacement-host").unwrap();
    registry
        .commit_created(
            target_incarnation.clone(),
            BackendCreatedRecord {
                launch_policy: Default::default(),
                daemon_id: DockerDaemonId::new(),
                container_id: "d".repeat(64),
                image_ref: format!("sha256:{}", "e".repeat(64)),
                runtime_dir: target_runtime_dir,
                host_binary_path: target_host,
                immutable_config_digest: format!("sha256:{}", "f".repeat(64)),
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(
            target_incarnation.clone(),
            HostBootId::new(),
            crate::checkpoints::tests::limits(),
        )
        .await
        .unwrap();
    let target_context = registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let source_launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: target_incarnation.clone(),
            launch_nonce: replacement.prepared.launch_nonce.as_str().into(),
            evidence_revision: target_context.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: Some(prior_root.clone()),
        })
        .await
        .unwrap();
    let authorization = registry
        .authorize_native_readiness_recovery(
            fixture.soul.clone(),
            target_incarnation.clone(),
            source_launch.clone(),
            resume_spec.clone(),
        )
        .await
        .unwrap()
        .expect("exact prepared Codex replacement receives narrow resume authorization");

    PreparedCodexReplacement {
        fixture,
        prior_incarnation,
        target_incarnation,
        attempt_id,
        prior_root,
        next_root: "native-after-recovery".into(),
        target_cwd,
        resume_spec,
        source_launch,
        authorization,
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TestNativeStoreSelection {
    cwd: String,
    provider_version: Option<String>,
    environment: std::collections::BTreeMap<String, String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TestNativeAbsenceCensus {
    provider: String,
    store: String,
    native_id: String,
    evidence_revision: u64,
    provider_home: String,
    environment_fingerprint: String,
    selection: TestNativeStoreSelection,
    inspected_home: String,
    generation: String,
    store_state: EvidenceStoreState,
}

fn native_absence_census_reference(
    resume_spec: &ResumeSpec,
    selection_cwd: &str,
    store_state: EvidenceStoreState,
) -> String {
    let environment = resume_spec
        .environment
        .iter()
        .filter(|(name, _)| {
            matches!(
                name.as_str(),
                "HOME"
                    | "CLAUDE_CONFIG_DIR"
                    | "CODEX_HOME"
                    | "AMPLIFIER_HOME"
                    | "XDG_DATA_HOME"
                    | "OPENCODE_DB"
                    | "OPENCODE_DISABLE_CHANNEL_DB"
            )
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let selection = TestNativeStoreSelection {
        cwd: selection_cwd.into(),
        provider_version: resume_spec.provider_version.clone(),
        environment,
    };
    let environment_fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(resume_spec.provider_home.as_str(), &selection)).unwrap()
        )
    );
    let census = TestNativeAbsenceCensus {
        provider: FreshProvider::Codex.as_str().into(),
        store: resume_spec.provider_session.provider_store_id.clone(),
        native_id: resume_spec.provider_session.native_session_id.clone(),
        evidence_revision: resume_spec.evidence_revision,
        provider_home: resume_spec.provider_home.clone(),
        environment_fingerprint,
        selection,
        inspected_home: resume_spec.provider_home.clone(),
        generation: "a".repeat(64),
        store_state,
    };
    format!(
        "nativeAbsenceCensus=v2:{}",
        serde_json::to_string(&census).unwrap()
    )
}

fn native_readiness_recovery_result(
    prepared: &PreparedCodexReplacement,
    census_cwd: &str,
) -> (NativeReadinessReceipt, NativeIdentityObservation) {
    native_readiness_recovery_result_with_store_state(
        prepared,
        census_cwd,
        EvidenceStoreState::Missing,
    )
}

fn native_readiness_recovery_result_with_store_state(
    prepared: &PreparedCodexReplacement,
    census_cwd: &str,
    store_state: EvidenceStoreState,
) -> (NativeReadinessReceipt, NativeIdentityObservation) {
    let mut next_launch = prepared.source_launch.clone();
    next_launch.evidence_revision += 1;
    next_launch.requested_native_session_id = Some(prepared.next_root.clone());
    let receipt = NativeReadinessReceipt {
        source_fence: prepared.authorization.source_fence.clone(),
        source_launch: prepared.source_launch.clone(),
        next_launch: next_launch.clone(),
        identity: NativeDispatchIdentity {
            previous_native_session_id: prepared.prior_root.clone(),
            native_session_id: prepared.next_root.clone(),
            pending_naming_handle: None,
        },
        absence_evidence: Some(NativeReadinessAbsenceEvidence {
            prior_incarnation_id: prepared.prior_incarnation.clone(),
            provider: FreshProvider::Codex.as_str().into(),
            provider_store_id: prepared
                .resume_spec
                .provider_session
                .provider_store_id
                .clone(),
            native_session_id: prepared.prior_root.clone(),
            evidence_revision: prepared.source_launch.evidence_revision,
            store_state: EvidenceStoreState::Missing,
            census_reference: native_absence_census_reference(
                &prepared.resume_spec,
                census_cwd,
                store_state,
            ),
        }),
        resume_spec_sha256: Some(prepared.authorization.resume_spec_sha256.clone()),
    };
    let observation = NativeIdentityObservation {
        native_session_id: prepared.next_root.clone(),
        incarnation_id: prepared.target_incarnation.clone(),
        launch_nonce: next_launch.launch_nonce.clone(),
        evidence_revision: next_launch.evidence_revision,
        source: NativeIdentitySource::FreshProviderHandshake,
        evidence_digest: "b".repeat(64),
    };
    (receipt, observation)
}

#[derive(Debug, PartialEq, Eq)]
struct NativeReadinessRegistrySnapshot {
    native_session_id: Option<String>,
    identity_revision: u64,
    evidence_revision: u64,
    resume_spec: Option<ResumeSpec>,
    native_identity_launch: Option<NativeIdentityLaunch>,
    fresh_agent: Option<FreshAgentLaunchSpec>,
    prior_claims: u64,
    next_claims: u64,
    receipt: Option<String>,
    observation: Option<String>,
}

async fn native_readiness_registry_snapshot(
    prepared: &PreparedCodexReplacement,
) -> NativeReadinessRegistrySnapshot {
    let registry = &prepared.fixture.supervisor.registry;
    let context = registry
        .recovery_context(prepared.fixture.soul.clone())
        .await
        .unwrap();
    let conn = rusqlite::Connection::open(registry.database_path()).unwrap();
    let claim_count = |native_session_id: &str| {
        conn.query_row(
            "SELECT COUNT(*) FROM writer_claims WHERE soul_id=?1 AND provider='codex' AND provider_store_id=?2 AND native_session_id=?3 AND incarnation_id=?4",
            rusqlite::params![
                prepared.fixture.soul.as_str(),
                prepared.resume_spec.provider_session.provider_store_id,
                native_session_id,
                prepared.target_incarnation.as_str(),
            ],
            |row| row.get::<_, u64>(0),
        )
        .unwrap()
    };
    let (receipt, observation): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT native_readiness_receipt,native_identity_observation FROM incarnations WHERE incarnation_id=?1",
            rusqlite::params![prepared.target_incarnation.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    NativeReadinessRegistrySnapshot {
        native_session_id: context.native_session_id,
        identity_revision: context.identity_revision,
        evidence_revision: context.evidence_revision,
        resume_spec: context.resume_spec,
        native_identity_launch: context.native_identity_launch,
        fresh_agent: context.fresh_agent,
        prior_claims: claim_count(&prepared.prior_root),
        next_claims: claim_count(&prepared.next_root),
        receipt,
        observation,
    }
}

fn native_send_reply(previous: &str, native: &str, pending: Option<String>) -> HostResult {
    HostResult::FreshAgentCommand {
        claude_fork: None,
        state: CommandState::ProviderAcked,
        native_session_id: Some(native.into()),
        native_identity: Some(NativeDispatchIdentity {
            previous_native_session_id: previous.into(),
            native_session_id: native.into(),
            pending_naming_handle: pending,
        }),
    }
}

async fn native_send_host(
    fixture: &RunningFreshAgent,
    replies: Vec<HostResult>,
    gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<usize>,
) {
    let secret = b"synthetic-host-secret";
    std::fs::write(fixture.runtime_dir.join("secret"), secret).unwrap();
    let listener = UnixListener::bind(fixture.runtime_dir.join("host.sock")).unwrap();
    let boot = HostBootId::new();
    let incarnation = fixture.incarnation.clone();
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let mut launch = context.native_identity_launch.unwrap();
    let mut observation = fixture
        .supervisor
        .registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.incarnation_id == fixture.incarnation)
        .unwrap()
        .native_identity_observation
        .expect("the current producer observation was published during fixture startup");
    let control_epoch = fixture.supervisor.registry.control_epoch();
    let (shutdown, mut stop) = tokio::sync::oneshot::channel();
    let host = tokio::spawn(async move {
        let mut replies = replies.into_iter();
        let mut sends = 0;
        let mut ready_for_send = false;
        loop {
            let mut socket =
                tokio::select! {_=&mut stop=>break,result=listener.accept()=>result.unwrap().0};
            let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
            let result = match envelope.body {
                HostCommand::Hello {incarnation_id,challenge} => HostResult::Hello {
                    host_boot_id:boot.clone(),proof:host_proof(secret,&challenge,&boot,&incarnation_id),capabilities:vec!["native-identity-observation-v1".into()],effective_limits:crate::checkpoints::tests::limits()
                },
                HostCommand::Status { incarnation_id } => {
                    assert_eq!(incarnation_id, incarnation);
                    assert_eq!(envelope.auth, Some(host_proof(secret, "command-auth", &boot, &incarnation)));
                    assert!(!ready_for_send, "only one readiness read may precede each original input");
                    assert!(observation.matches_launch(&launch));
                    ready_for_send = true;
                    HostResult::Status { fresh_agent_recovery_source: None,
                        host_boot_id: boot.clone(),
                        worker_pid: Some(123),
                        worker_launch_count: 1,
                        max_control_epoch: control_epoch,
                        max_execution_generation: launch.execution_generation,
                        fixture_evidence: serde_json::Value::Null,
                        exited: false,
                        native_session_id: Some(observation.native_session_id.clone()),
                        native_identity_observation: Some(observation.clone()),
                        native_readiness_receipt: None,
                        opencode_transfer_receipt: None,
                        opencode_adoption: Default::default(),
                    }
                },
                HostCommand::FreshAgentSend {incarnation_id,..} => {
                    assert_eq!(incarnation_id,incarnation);
                    assert_eq!(envelope.auth,Some(host_proof(secret,"command-auth",&boot,&incarnation)));
                    assert!(ready_for_send, "current native readiness must precede the original input");
                    ready_for_send = false;
                    sends+=1;
                    if let Some((entered,release))=&gate {entered.notify_one();release.notified().await;}
                    let reply = replies.next().expect("no input may be automatically resent");
                    if let HostResult::FreshAgentCommand {
                        state: CommandState::ProviderAcked | CommandState::Completed,
                        native_session_id: Some(native), ..
                    } = &reply {
                        if native != &observation.native_session_id {
                            launch.evidence_revision += 1;
                            launch.requested_native_session_id = Some(native.clone());
                            observation.native_session_id = native.clone();
                            observation.evidence_revision = launch.evidence_revision;
                        }
                    }
                    reply
                },
                other=>panic!("native acknowledgement must not create/start/configure/probe a provider: {other:?}")
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
        assert!(
            !ready_for_send,
            "an acknowledgement must not trigger a trailing native probe"
        );
        sends
    });
    (shutdown, host)
}

#[tokio::test]
async fn accepted_native_recovery_preserves_presentation_and_pending_name_policy() {
    for pending in [false, true] {
        let fixture = running_fresh_provider_with_name(
            FreshProvider::Codex,
            Some("pending-original".into()),
            "native-original",
        )
        .await;
        fixture
            .supervisor
            .registry
            .record_native_session(
                fixture.soul.clone(),
                fixture.incarnation.clone(),
                "native-original".into(),
            )
            .await
            .unwrap();
        let before = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        let before_spec = before.fresh_agent.unwrap();
        let handle = pending.then(|| "pending-original".to_string());
        let mut replies = Vec::new();
        if !pending {
            replies.push(native_send_reply(
                "native-original",
                "native-original",
                None,
            ));
        }
        replies.push(native_send_reply(
            "native-original",
            "native-recovered",
            handle.clone(),
        ));
        replies.push(native_send_reply(
            "native-recovered",
            "native-recovered",
            handle.clone(),
        ));
        let expected_sends = replies.len();
        let (shutdown, host) = native_send_host(&fixture, replies, None).await;
        let mut results = Vec::new();
        let mut same_native = None;
        for index in 0..expected_sends {
            let result = fixture
                .supervisor
                .fresh_agent_send(
                    RequestId::new(),
                    fixture.soul.clone(),
                    format!("controlled native input {index}"),
                    None,
                    None,
                )
                .await;
            let failed = result.is_err();
            results.push(result);
            if !pending && index == 0 {
                same_native = Some(
                    fixture
                        .supervisor
                        .registry
                        .recovery_context(fixture.soul.clone())
                        .await
                        .unwrap(),
                );
            }
            if failed {
                break;
            }
        }
        shutdown.send(()).unwrap();
        let sends = host.await.unwrap();
        for result in results {
            result.expect(
                "native acceptance must atomically persist current source and pending-name state",
            );
        }
        assert_eq!(sends, expected_sends);
        if let Some(same) = same_native {
            assert_eq!(same.native_session_id.as_deref(), Some("native-original"));
            assert!(same.fresh_agent.unwrap().naming_handle.is_none(),"consumed pending authority must clear on ordinary same-native accepts, keeping the actor/recovery spec consistent");
        }
        let after = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        let spec = after.fresh_agent.unwrap();
        assert_eq!(after.native_session_id.as_deref(), Some("native-recovered"));
        assert_eq!(
            spec.session_id, before_spec.session_id,
            "presentation reference must remain byte-identical"
        );
        assert_eq!(spec.native_session_id.as_deref(), Some("native-recovered"));
        assert_eq!(spec.naming_handle, handle);
        assert_eq!(spec.model, before_spec.model);
        assert_eq!(spec.effort, before_spec.effort);
        assert_eq!(spec.cwd, before_spec.cwd);
        assert_eq!(spec.permission_mode, before_spec.permission_mode);
        assert_eq!(spec.sandbox, before_spec.sandbox);
        let connection =
            rusqlite::Connection::open(fixture.supervisor.registry.database_path()).unwrap();
        let claims: Vec<String> = connection
            .prepare("SELECT native_session_id FROM writer_claims WHERE soul_id=?1")
            .unwrap()
            .query_map([fixture.soul.as_str()], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(claims, vec!["native-recovered".to_string()]);
    }
}

#[tokio::test]
async fn codex_readiness_reconciles_receipt_after_host_commit_reply_is_lost() {
    let fixture = running_fresh_provider_with_name(
        FreshProvider::Codex,
        Some("pending-original".into()),
        "native-original",
    )
    .await;
    let source = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let source_launch = source.native_identity_launch.clone().unwrap();
    let expected_source_fence = source.write_fence().native_readiness_fence();
    let child_native = "native-recovered".to_string();
    let host_secret = b"synthetic-readiness-host-secret";
    std::fs::write(fixture.runtime_dir.join("secret"), host_secret).unwrap();
    let listener = UnixListener::bind(fixture.runtime_dir.join("host.sock")).unwrap();
    let boot = HostBootId::new();
    let incarnation = fixture.incarnation.clone();
    let control_epoch = fixture.supervisor.registry.control_epoch();
    let current_observation = Arc::new(StdMutex::new(None::<NativeIdentityObservation>));
    let receipt = Arc::new(StdMutex::new(None::<NativeReadinessReceipt>));
    let readiness_requests = Arc::new(StdMutex::new(0usize));
    let provider_operations = Arc::new(StdMutex::new(0usize));
    let (shutdown, mut stop) = tokio::sync::oneshot::channel();

    let host = {
        let current_observation = current_observation.clone();
        let receipt = receipt.clone();
        let readiness_requests = readiness_requests.clone();
        let provider_operations = provider_operations.clone();
        let source_launch = source_launch.clone();
        let expected_source_fence = expected_source_fence.clone();
        let child_native = child_native.clone();
        let incarnation = incarnation.clone();
        let boot = boot.clone();
        let listener = listener;
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut stop => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let result = match request.body {
                    HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => Some(HostResult::Hello {
                        host_boot_id: boot.clone(),
                        proof: host_proof(host_secret, &challenge, &boot, &incarnation_id),
                        capabilities: vec![
                            "provider-store-probe-v1".into(),
                            "native-identity-observation-v1".into(),
                            HOST_CAPABILITY_NATIVE_READINESS_RECEIPT_V1.into(),
                        ],
                        effective_limits: crate::checkpoints::tests::limits(),
                    }),
                    HostCommand::Status { incarnation_id } => {
                        assert_eq!(incarnation_id, incarnation);
                        let observation = current_observation.lock().unwrap().clone();
                        Some(HostResult::Status {
                            native_session_id: observation
                                .as_ref()
                                .map(|observation| observation.native_session_id.clone()),
                            native_identity_observation: observation,
                            fresh_agent_recovery_source: None,
                            host_boot_id: boot.clone(),
                            worker_pid: Some(123),
                            worker_launch_count: 1,
                            max_control_epoch: control_epoch,
                            max_execution_generation: source_launch.execution_generation,
                            fixture_evidence: serde_json::json!({}),
                            exited: false,
                            native_readiness_receipt: None,
                            opencode_transfer_receipt: None,
                            opencode_adoption: Default::default(),
                        })
                    }
                    HostCommand::ProbeRecovery { resume_spec, .. } => {
                        let resume_spec =
                            resume_spec.expect("Codex readiness probes its exact root");
                        Some(HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                            evidence_revision: resume_spec.evidence_revision,
                            resume_spec,
                        }))
                    }
                    HostCommand::FreshAgentPrepareNative {
                        incarnation_id,
                        expected_launch,
                        source_fence,
                    } => {
                        assert_eq!(incarnation_id, incarnation);
                        let expected_launch =
                            expected_launch.expect("receipt requests the original launch");
                        let source_fence =
                            source_fence.expect("receipt requests the original fence");
                        assert_eq!(expected_launch, source_launch);
                        assert_eq!(source_fence, expected_source_fence);
                        let request_number = {
                            let mut requests = readiness_requests.lock().unwrap();
                            *requests += 1;
                            *requests
                        };
                        let mut durable = receipt.lock().unwrap();
                        let accepted = if let Some(existing) = durable.as_ref() {
                            assert_eq!(existing.source_launch, source_launch);
                            assert_eq!(existing.source_fence, expected_source_fence);
                            assert_eq!(existing.identity.native_session_id, child_native);
                            existing.clone()
                        } else {
                            *provider_operations.lock().unwrap() += 1;
                            let identity = NativeDispatchIdentity {
                                previous_native_session_id: "native-original".into(),
                                native_session_id: child_native.clone(),
                                pending_naming_handle: Some("pending-original".into()),
                            };
                            let mut next_launch = source_launch.clone();
                            next_launch.evidence_revision += 1;
                            next_launch.requested_native_session_id = Some(child_native.clone());
                            let accepted = NativeReadinessReceipt {
                                source_fence: expected_source_fence.clone(),
                                source_launch: source_launch.clone(),
                                next_launch: next_launch.clone(),
                                identity,
                                absence_evidence: None,
                                resume_spec_sha256: None,
                            };
                            assert!(accepted.is_valid());
                            *durable = Some(accepted.clone());
                            *current_observation.lock().unwrap() =
                                Some(NativeIdentityObservation {
                                    native_session_id: child_native.clone(),
                                    incarnation_id: incarnation.clone(),
                                    launch_nonce: next_launch.launch_nonce.clone(),
                                    evidence_revision: next_launch.evidence_revision,
                                    source: NativeIdentitySource::FreshProviderHandshake,
                                    evidence_digest: "d".repeat(64),
                                });
                            accepted
                        };
                        if request_number == 1 {
                            // Host/actor and provider acceptance are durable,
                            // but the supervisor never receives this reply.
                            None
                        } else {
                            Some(HostResult::FreshAgentCommand {
                                state: CommandState::ProviderAcked,
                                claude_fork: None,
                                native_session_id: Some(child_native.clone()),
                                native_identity: Some(accepted.identity),
                            })
                        }
                    }
                    other => panic!("unexpected Codex readiness command: {other:?}"),
                };
                if let Some(result) = result {
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            }
        })
    };

    let prepare = || {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentPrepareNative(FreshAgentInterruptRequest {
                soul_id: fixture.soul.clone(),
                request_id: None,
                expected_control_epoch: Some(control_epoch),
            }),
        );
        envelope.auth = Some(SECRET.into());
        envelope
    };
    let first = fixture.supervisor.dispatch(prepare()).await;
    assert!(
        first.result.is_err(),
        "the host committed but lost its reply"
    );
    let split = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(split.native_session_id.as_deref(), Some("native-original"));
    assert_eq!(
        split.native_identity_launch.as_ref(),
        Some(&source_launch),
        "the first missing reply cannot partially commit registry identity"
    );

    let second = fixture.supervisor.dispatch(prepare()).await;
    if second.result.is_err() {
        let current = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        let active = fixture
            .supervisor
            .registry
            .active_handle_for_soul(fixture.soul.clone())
            .await
            .unwrap();
        let host = fixture
            .supervisor
            .authenticate_host(active.incarnation_id(), active.runtime_dir())
            .await
            .unwrap();
        let status = fixture
            .supervisor
            .host_status(active.incarnation_id().clone(), active.runtime_dir(), &host)
            .await
            .unwrap();
        eprintln!(
            "reconciliation diagnostics: error={:?}; registry root={:?}, launch={:?}, evidence={}; host root={:?}, observation={:?}, exited={}, generation={}; observation_matches={}",
            second.result,
            current.native_session_id,
            current.native_identity_launch,
            current.evidence_revision,
            status.native_session_id,
            status.native_identity_observation,
            status.exited,
            status.max_execution_generation,
            crate::recovery::current_native_observation(&current, &status).is_some(),
        );
    }
    assert!(
        matches!(
            second.result,
            Ok(AdminResult::FreshAgentCommand {
                state: CommandState::Completed
            })
        ),
        "second readiness reply: {:?}",
        second.result
    );
    assert_eq!(*readiness_requests.lock().unwrap(), 2);
    assert_eq!(
        *provider_operations.lock().unwrap(),
        1,
        "retry must replay the durable receipt without repeating provider work"
    );
    let committed = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(
        committed.native_session_id.as_deref(),
        Some("native-recovered")
    );
    let receipt_next_launch = receipt
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .next_launch
        .clone();
    assert_eq!(
        committed.native_identity_launch.as_ref(),
        Some(&receipt_next_launch)
    );
    let spec = committed.fresh_agent.unwrap();
    assert_eq!(spec.session_id, source.fresh_agent.unwrap().session_id);
    assert_eq!(spec.naming_handle.as_deref(), Some("pending-original"));

    shutdown.send(()).unwrap();
    host.await.unwrap();
}

#[tokio::test]
async fn codex_recovery_authorization_binds_the_exact_prepared_source_attempt_and_target() {
    let prepared = prepared_codex_replacement().await;
    let registry = &prepared.fixture.supervisor.registry;
    let authorization = &prepared.authorization;

    assert!(authorization.is_valid_for(
        &registry
            .recovery_context(prepared.fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent
            .unwrap(),
        &prepared.resume_spec,
    ));
    assert_eq!(
        authorization.prior_incarnation_id,
        prepared.prior_incarnation
    );
    assert_eq!(
        authorization.source_fence.active_incarnation_id,
        prepared.target_incarnation
    );
    assert_eq!(
        authorization.source_fence.recovery_attempt_id.as_ref(),
        Some(&prepared.attempt_id)
    );
    assert_eq!(
        authorization.source_fence.evidence_revision,
        prepared.source_launch.evidence_revision
    );
    assert_eq!(authorization.source_launch, prepared.source_launch);
    assert_eq!(
        authorization
            .source_launch
            .requested_native_session_id
            .as_deref(),
        Some(prepared.prior_root.as_str())
    );
    assert_eq!(
        authorization.resume_spec_sha256,
        resume_spec_sha256(&prepared.resume_spec)
    );
    assert_ne!(
        prepared.resume_spec.cwd, prepared.target_cwd,
        "the exact prior store proof keeps its original CWD while the replacement keeps accepted settings"
    );

    let before = native_readiness_registry_snapshot(&prepared).await;
    let mut stale_launch = prepared.source_launch.clone();
    stale_launch.launch_nonce.push_str("-stale");
    assert!(registry
        .authorize_native_readiness_recovery(
            prepared.fixture.soul.clone(),
            prepared.target_incarnation.clone(),
            stale_launch,
            prepared.resume_spec.clone(),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let mut wrong_resume = prepared.resume_spec.clone();
    wrong_resume.cwd = prepared.target_cwd.clone();
    assert!(registry
        .authorize_native_readiness_recovery(
            prepared.fixture.soul.clone(),
            prepared.target_incarnation.clone(),
            prepared.source_launch.clone(),
            wrong_resume,
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    assert!(registry
        .authorize_native_readiness_recovery(
            prepared.fixture.soul.clone(),
            IncarnationId::new(),
            prepared.source_launch.clone(),
            prepared.resume_spec.clone(),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);
}

#[tokio::test]
async fn codex_recovery_receipt_commit_is_fenced_atomic_and_idempotent() {
    let prepared = prepared_codex_replacement().await;
    let registry = &prepared.fixture.supervisor.registry;
    let (receipt, observation) =
        native_readiness_recovery_result(&prepared, &prepared.resume_spec.cwd);
    assert!(receipt.is_valid());
    let before = native_readiness_registry_snapshot(&prepared).await;

    let mut wrong_attempt = prepared.authorization.clone();
    wrong_attempt.source_fence.recovery_attempt_id = Some(RecoveryAttemptId::new());
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            Some(wrong_attempt),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let mut wrong_prior = prepared.authorization.clone();
    wrong_prior.prior_incarnation_id = IncarnationId::new();
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            Some(wrong_prior),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let mut wrong_launch_authority = prepared.authorization.clone();
    wrong_launch_authority
        .source_launch
        .launch_nonce
        .push_str("-stale");
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            Some(wrong_launch_authority),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let mut wrong_resume = prepared.resume_spec.clone();
    wrong_resume.cwd = prepared.target_cwd.clone();
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            Some(prepared.authorization.clone()),
            Some(wrong_resume),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let (wrong_census, wrong_census_observation) =
        native_readiness_recovery_result(&prepared, &prepared.target_cwd);
    assert!(wrong_census.is_valid());
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            wrong_census,
            wrong_census_observation,
            Some(prepared.authorization.clone()),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let (unknown_census, unknown_census_observation) =
        native_readiness_recovery_result_with_store_state(
            &prepared,
            &prepared.resume_spec.cwd,
            EvidenceStoreState::Unknown,
        );
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            unknown_census,
            unknown_census_observation,
            Some(prepared.authorization.clone()),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .is_err());
    assert_eq!(native_readiness_registry_snapshot(&prepared).await, before);

    let committed_fence = registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            Some(prepared.authorization.clone()),
            Some(prepared.resume_spec.clone()),
        )
        .await
        .unwrap();
    let committed = native_readiness_registry_snapshot(&prepared).await;
    assert_eq!(
        committed.native_session_id.as_deref(),
        Some("native-after-recovery")
    );
    assert_eq!(committed.identity_revision, before.identity_revision + 1);
    assert_eq!(committed.evidence_revision, before.evidence_revision + 1);
    assert!(
        committed.resume_spec.is_none(),
        "the prior root proof is stale after mint"
    );
    assert_eq!(committed.prior_claims, 0);
    assert_eq!(committed.next_claims, 1);
    assert_eq!(
        committed.native_identity_launch.as_ref(),
        Some(&receipt.next_launch)
    );
    let updated_spec = committed.fresh_agent.as_ref().unwrap();
    assert_eq!(updated_spec.cwd, prepared.target_cwd);
    assert_eq!(updated_spec.session_id, "fresh-session");
    assert_eq!(updated_spec.model.as_deref(), Some("sonnet"));
    assert_eq!(
        updated_spec.naming_handle.as_deref(),
        Some("pending-before-recovery")
    );
    assert_eq!(
        updated_spec.native_session_id.as_deref(),
        Some("native-after-recovery")
    );
    assert_eq!(
        updated_spec
            .session_ref
            .as_ref()
            .map(|reference| reference.session_id.as_str()),
        Some("native-after-recovery")
    );
    assert!(committed.receipt.is_some());
    assert!(committed.observation.is_some());

    let replay_fence = registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt.clone(),
            observation.clone(),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(replay_fence, committed_fence);
    let replayed = native_readiness_registry_snapshot(&prepared).await;
    assert_eq!(replayed, committed, "exact receipt replay must be a no-op");

    registry
        .mark_running(prepared.target_incarnation.clone())
        .await
        .unwrap();
    let recovered = registry
        .recovery_context(prepared.fixture.soul.clone())
        .await
        .unwrap();
    registry
        .mark_recovery_live(
            prepared.fixture.soul.clone(),
            prepared.target_incarnation.clone(),
            recovered.write_fence(),
        )
        .await
        .unwrap();

    let replacement_start = registry
        .begin_recovery_fenced(
            prepared.fixture.soul.clone(),
            RecoveryTrigger::ManualRetry,
            RecoveryPath::CheckpointRestore,
            registry
                .recovery_context(prepared.fixture.soul.clone())
                .await
                .unwrap()
                .write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_stop_outcome(
            prepared.target_incarnation.clone(),
            StopOutcome::VerifiedEmpty,
        )
        .await
        .unwrap();
    let replacement_spec = replacement_start
        .context
        .fresh_agent
        .clone()
        .expect("Codex replacement keeps the accepted fresh-agent settings");
    let replacement = registry
        .prepare_replacement(
            replacement_start,
            None,
            Some(replacement_spec),
            None,
            RecoveryPath::CheckpointRestore,
        )
        .await
        .unwrap();
    let replacement_incarnation = replacement.prepared.incarnation_id.clone();
    let replacement_runtime_dir = prepared
        .fixture
        ._root
        .path()
        .join("stale-replay-replacement-runtime");
    std::fs::create_dir_all(&replacement_runtime_dir).unwrap();
    let replacement_host = replacement_runtime_dir.join("host");
    std::fs::write(&replacement_host, b"synthetic-newer-host").unwrap();
    registry
        .commit_created(
            replacement_incarnation.clone(),
            BackendCreatedRecord {
                launch_policy: Default::default(),
                daemon_id: DockerDaemonId::new(),
                container_id: "1".repeat(64),
                image_ref: format!("sha256:{}", "2".repeat(64)),
                runtime_dir: replacement_runtime_dir,
                host_binary_path: replacement_host,
                immutable_config_digest: format!("sha256:{}", "3".repeat(64)),
            },
        )
        .await
        .unwrap();
    registry
        .commit_execution_grant(
            replacement_incarnation.clone(),
            HostBootId::new(),
            crate::checkpoints::tests::limits(),
        )
        .await
        .unwrap();

    assert_eq!(
        registry
            .recovery_context(prepared.fixture.soul.clone())
            .await
            .unwrap()
            .prior_handle
            .incarnation_id(),
        &replacement_incarnation,
        "target B must be the active incarnation before stale receipt replay"
    );
    let replacement_state = native_readiness_registry_snapshot(&prepared).await;
    assert!(registry
        .record_native_readiness_recovery_receipt(
            prepared.fixture.soul.clone(),
            receipt,
            observation,
            None,
            None,
        )
        .await
        .is_err());
    assert_eq!(
        native_readiness_registry_snapshot(&prepared).await,
        replacement_state,
        "a stale receipt replay must not return a newer target's fence or mutate its state"
    );
}

#[tokio::test]
async fn native_dispatch_rejects_stale_invalid_and_nonaccepted_identity_authority() {
    for scenario in [
        "untagged",
        "wrong-parent",
        "wrong-reply",
        "missing-reply",
        "invalid-native",
        "foreign-pending",
        "wrong-provider",
        "ambiguous",
        "refused",
        "stop-intent",
    ] {
        let fixture = running_fresh_provider_with_name(
            if scenario == "wrong-provider" {
                FreshProvider::Claude
            } else {
                FreshProvider::Codex
            },
            Some("pending-original".into()),
            "native-original",
        )
        .await;
        fixture
            .supervisor
            .registry
            .record_native_session(
                fixture.soul.clone(),
                fixture.incarnation.clone(),
                "native-original".into(),
            )
            .await
            .unwrap();
        let before = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent;
        let native = if scenario == "invalid-native" {
            "native\ninvalid"
        } else {
            "native-recovered"
        };
        let mut reply = native_send_reply(
            if scenario == "wrong-parent" {
                "stale-native"
            } else {
                "native-original"
            },
            native,
            if scenario == "foreign-pending" {
                Some("unrelated-pending".into())
            } else {
                None
            },
        );
        if let HostResult::FreshAgentCommand {
            state,
            native_session_id,
            native_identity,
            ..
        } = &mut reply
        {
            match scenario {
                "untagged" => *native_identity = None,
                "wrong-reply" => *native_session_id = Some("different-reply".into()),
                "missing-reply" => *native_session_id = None,
                "ambiguous" => *state = CommandState::Ambiguous,
                "refused" => *state = CommandState::Cancelled,
                _ => {}
            }
        }
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (shutdown, host) = native_send_host(
            &fixture,
            vec![reply],
            (scenario == "stop-intent").then(|| (entered.clone(), release.clone())),
        )
        .await;
        let work = tokio::spawn({
            let supervisor = fixture.supervisor.clone();
            let soul = fixture.soul.clone();
            async move {
                supervisor
                    .fresh_agent_send(
                        RequestId::new(),
                        soul,
                        "controlled refused identity".into(),
                        None,
                        None,
                    )
                    .await
            }
        });
        if scenario == "stop-intent" {
            tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
                .await
                .unwrap();
            fixture
                .supervisor
                .registry
                .begin_stop(fixture.soul.clone())
                .await
                .unwrap();
            release.notify_one();
        }
        let result = work.await.unwrap();
        shutdown.send(()).unwrap();
        assert_eq!(host.await.unwrap(), 1);
        assert!(
            !matches!(
                result,
                Ok(CommandState::ProviderAcked | CommandState::Completed)
            ),
            "{scenario}: {result:?}"
        );
        let after = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        assert_eq!(
            after.native_session_id.as_deref(),
            Some("native-original"),
            "{scenario}"
        );
        assert_eq!(after.fresh_agent, before, "{scenario}");
    }
}

/// An authenticated session host that records every command it is sent.
fn fake_host(
    runtime_dir: &std::path::Path,
) -> (Arc<StdMutex<Vec<HostCommand>>>, tokio::task::JoinHandle<()>) {
    fake_host_with_boot_change(runtime_dir, false)
}
fn fake_host_with_boot_change(
    runtime_dir: &std::path::Path,
    change_boot: bool,
) -> (Arc<StdMutex<Vec<HostCommand>>>, tokio::task::JoinHandle<()>) {
    fake_host_with_boot(runtime_dir, change_boot, HostBootId::new())
}
fn fake_host_with_boot(
    runtime_dir: &std::path::Path,
    change_boot: bool,
    boot: HostBootId,
) -> (Arc<StdMutex<Vec<HostCommand>>>, tokio::task::JoinHandle<()>) {
    let secret = b"synthetic-host-secret";
    std::fs::write(runtime_dir.join("secret"), secret).unwrap();
    let listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
    let received = Arc::new(StdMutex::new(Vec::new()));
    let log = Arc::clone(&received);
    let task = tokio::spawn(async move {
        let mut hello_count = 0;
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
                } => {
                    hello_count += 1;
                    let current = if change_boot && hello_count > 1 {
                        HostBootId::new()
                    } else {
                        boot.clone()
                    };
                    HostResult::Hello {
                        host_boot_id: current.clone(),
                        proof: host_proof(secret, &challenge, &current, &incarnation_id),
                        capabilities: vec![],
                        effective_limits: crate::checkpoints::tests::limits(),
                    }
                }
                HostCommand::FreshAgentModelCatalog { cwd, .. } => {
                    assert_eq!(cwd.as_deref(), Some("/bound/project"));
                    HostResult::FreshAgentModelCatalog(
                        serde_json::json!([{"id":"provider-current","displayName":"Provider Current","supportedEffortLevels":["ultra"],"defaultEffort":"ultra"}]),
                    )
                }
                HostCommand::FreshAgentNativeName {
                    native_session_id,
                    codex_home,
                    operation,
                    ..
                } => {
                    assert_eq!(native_session_id, "name-native");
                    assert_eq!(codex_home, "/owning/codex");
                    HostResult::FreshAgentNativeName(match operation {
                        FreshAgentNativeNameOperation::Probe => {
                            FreshAgentNativeNameReply::Available
                        }
                        FreshAgentNativeNameOperation::Read => {
                            FreshAgentNativeNameReply::Title(Some("Native title".into()))
                        }
                        FreshAgentNativeNameOperation::Write { title } => {
                            assert_eq!(title, "Manual title");
                            FreshAgentNativeNameReply::Renamed
                        }
                    })
                }
                HostCommand::FreshAgentConfigure { .. } => HostResult::FreshAgentCommand {
                    native_identity: None,
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
        collaboration_mode: None,
        cwd: None,
        model: Some("opus".into()),
        effort: Some(Some("high".into())),
        permission_mode: None,
        sandbox: None,
    }
}

#[tokio::test]
async fn task008_settings_admin_codex_absent_effort_preserves_and_null_clears_recovery_defaults() {
    let fixture = running_fresh_provider(FreshProvider::Codex).await;
    let (received, host) = fake_host(&fixture.runtime_dir);
    let epoch = fixture.supervisor.registry.control_epoch();
    let original = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .fresh_agent
        .unwrap();
    for (request, patch, expected) in [
        (
            "codex-cwd-only",
            serde_json::json!({"cwd":original.cwd,"collaborationMode":"plan","sandbox":"read-only"}),
            Some("low"),
        ),
        (
            "codex-native-default",
            serde_json::json!({"effort":null}),
            None,
        ),
    ] {
        let reply = fixture
            .supervisor
            .dispatch(configure_envelope_with(
                &fixture.soul,
                &RequestId::parse(request).unwrap(),
                Some(epoch),
                serde_json::from_value(patch).unwrap(),
            ))
            .await;
        assert!(reply.result.is_ok(), "{:?}", reply.result);
        let recovered = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent
            .unwrap();
        assert_eq!(recovered.effort.as_deref(), expected);
        assert_eq!(recovered.collaboration_mode.as_deref(), Some("plan"));
        assert_eq!(recovered.sandbox.as_deref(), Some("read-only"));
        assert_eq!(recovered.model, original.model);
    }
    host.abort();
    let _ = host.await;
    let configures: Vec<_> = received
        .lock()
        .unwrap()
        .iter()
        .filter_map(|command| match command {
            HostCommand::FreshAgentConfigure { settings, .. } => Some(settings.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(configures.len(), 2);
    assert_eq!(configures[0].effort, None);
    assert_eq!(configures[1].effort, Some(None));
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

#[tokio::test]
async fn verified_resume_capture_preserves_cleared_settings_and_history_anchors() {
    let fixture =
        running_fresh_provider_with_name(FreshProvider::Codex, None, "resume-native").await;
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let mut candidate = crate::resume_catalog::exact_resume_candidate(&context, None)
        .unwrap()
        .unwrap();
    candidate.model = Some("cached-model".into());
    candidate.reasoning_effort = Some("high".into());
    candidate.permission_mode = Some("untrusted".into());
    let saved = fixture
        .supervisor
        .registry
        .store_verified_resume_spec_fenced(fixture.soul.clone(), candidate, context.write_fence())
        .await
        .unwrap();
    let mut current = saved.clone();
    current.model = None;
    current.reasoning_effort = None;
    current.permission_mode = Some("never".into());
    let fence = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .write_fence();
    let captured = fixture
        .supervisor
        .registry
        .store_verified_resume_spec_fenced(fixture.soul.clone(), current, fence)
        .await
        .unwrap();
    assert_eq!(captured.model, None);
    assert_eq!(captured.reasoning_effort, None);
    assert_eq!(captured.permission_mode.as_deref(), Some("never"));
    assert_eq!(captured.provider_session, saved.provider_session);
    assert_eq!(captured.durable_position, saved.durable_position);
    assert_eq!(captured.checkpoint_references, saved.checkpoint_references);
    assert!(captured.evidence_revision > saved.evidence_revision);
    let fence = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .write_fence();
    let repeated = fixture
        .supervisor
        .registry
        .store_verified_resume_spec_fenced(fixture.soul.clone(), captured.clone(), fence)
        .await
        .unwrap();
    assert_eq!(
        repeated, captured,
        "an identical recapture stays idempotent"
    );
}

#[tokio::test]
async fn native_name_lifecycle_contention_is_undispatched_and_fresh_retry_succeeds() {
    let fixture = running_fresh_provider_with_name(FreshProvider::Codex, None, "name-native").await;
    let view = fixture
        .supervisor
        .registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.soul_id == fixture.soul)
        .unwrap();
    let source = FreshAgentNativeNameSource {
        incarnation_id: view.incarnation_id,
        host_boot_id: view.host_boot_id.unwrap(),
        execution_generation: view.execution_generation,
        intent_revision: view.intent_revision,
        native_session_id: "name-native".into(),
    };
    let (received, host) =
        fake_host_with_boot(&fixture.runtime_dir, false, source.host_boot_id.clone());
    let mut request = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::FreshAgentNativeName(FreshAgentNativeNameRequest {
            soul_id: fixture.soul.clone(),
            source,
            codex_home: "/owning/codex".into(),
            operation: FreshAgentNativeNameOperation::Write {
                title: "Manual title".into(),
            },
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        }),
    );
    request.auth = Some(SECRET.into());
    let lifecycle = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
    let held = lifecycle.lock().await;
    let reply = fixture
        .supervisor
        .dispatch(request.clone())
        .await
        .result
        .unwrap();
    let AdminResult::FreshAgentNativeName(reply) = reply else {
        panic!("wrong reply")
    };
    assert_eq!(
        serde_json::to_value(&reply).unwrap()["data"]["kind"],
        "lifecycle_busy"
    );
    assert!(
        received.lock().unwrap().is_empty(),
        "contention must dispatch no host command"
    );
    drop(held);

    let retried = fixture.supervisor.dispatch(request).await.result.unwrap();
    assert!(matches!(
        retried,
        AdminResult::FreshAgentNativeName(FreshAgentNativeNameReply::Renamed)
    ));
    assert_eq!(
        received
            .lock()
            .unwrap()
            .iter()
            .filter(|command| matches!(command, HostCommand::FreshAgentNativeName { .. }))
            .count(),
        1
    );
    host.abort();
    let _ = host.await;
}

#[tokio::test]
async fn admin_native_name_rejects_stale_authority_before_host_work_and_preserves_recovery() {
    for scenario in [
        "read",
        "write",
        "probe",
        "busy",
        "stale-native",
        "stale-boot",
        "stale-incarnation",
        "stale-generation",
        "stale-intent",
        "stale-epoch",
        "wrong-provider",
        "boot-changes",
    ] {
        let fixture = running_fresh_provider_with_name(
            if scenario == "wrong-provider" {
                FreshProvider::Claude
            } else {
                FreshProvider::Codex
            },
            None,
            "name-native",
        )
        .await;
        let view = fixture
            .supervisor
            .registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|view| view.soul_id == fixture.soul)
            .unwrap();
        let before = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent;
        let mut source = FreshAgentNativeNameSource {
            incarnation_id: view.incarnation_id.clone(),
            host_boot_id: view.host_boot_id.clone().unwrap(),
            execution_generation: view.execution_generation,
            intent_revision: view.intent_revision,
            native_session_id: "name-native".into(),
        };
        let (received, host) = fake_host_with_boot(
            &fixture.runtime_dir,
            scenario == "boot-changes",
            source.host_boot_id.clone(),
        );
        match scenario {
            "stale-native" => source.native_session_id = "foreign-native".into(),
            "stale-boot" => source.host_boot_id = HostBootId::new(),
            "stale-incarnation" => source.incarnation_id = IncarnationId::new(),
            "stale-generation" => source.execution_generation += 1,
            "stale-intent" => source.intent_revision += 1,
            _ => {}
        }
        let epoch = fixture.supervisor.registry.control_epoch();
        let mut request = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentNativeName(FreshAgentNativeNameRequest {
                soul_id: fixture.soul.clone(),
                source,
                codex_home: "/owning/codex".into(),
                operation: match scenario {
                    "write" => FreshAgentNativeNameOperation::Write {
                        title: "Manual title".into(),
                    },
                    "probe" => FreshAgentNativeNameOperation::Probe,
                    _ => FreshAgentNativeNameOperation::Read,
                },
                expected_control_epoch: Some(if scenario == "stale-epoch" {
                    epoch + 1
                } else {
                    epoch
                }),
            }),
        );
        request.auth = Some(SECRET.into());
        let lifecycle = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
        let _busy_guard = if scenario == "busy" {
            Some(lifecycle.lock().await)
        } else {
            None
        };
        let reply = fixture.supervisor.dispatch(request).await;
        host.abort();
        let _ = host.await;
        if scenario == "stale-epoch" {
            assert_eq!(
                reply.result.unwrap_err().code,
                RuntimeErrorCode::StaleControlEpoch
            );
        } else {
            let AdminResult::FreshAgentNativeName(reply) = reply.result.unwrap() else {
                panic!("wrong reply")
            };
            match scenario {
                "read" => assert_eq!(
                    reply,
                    FreshAgentNativeNameReply::Title(Some("Native title".into()))
                ),
                "write" => assert_eq!(reply, FreshAgentNativeNameReply::Renamed),
                "probe" => assert_eq!(reply, FreshAgentNativeNameReply::Available),
                "boot-changes" => assert_eq!(
                    reply,
                    FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Closed)
                ),
                "busy" => assert_eq!(
                    reply,
                    FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::LifecycleBusy)
                ),
                _ => assert!(matches!(
                    reply,
                    FreshAgentNativeNameReply::Failed(
                        FreshAgentNativeNameError::Unavailable { .. }
                    )
                )),
            }
        }
        {
            let calls = received.lock().unwrap();
            if scenario.starts_with("stale-") || scenario == "wrong-provider" || scenario == "busy"
            {
                assert!(
                    calls.is_empty(),
                    "{scenario}: no host/native work for stale authority"
                );
            } else {
                assert_eq!(
                    calls
                        .iter()
                        .filter(|command| matches!(
                            command,
                            HostCommand::FreshAgentNativeName { .. }
                        ))
                        .count(),
                    1
                );
            }
        }
        let expected_refusal = match scenario {
            "busy" => Some(("lifecycle_busy", "info")),
            "stale-native" | "stale-boot" | "stale-incarnation" | "stale-generation"
            | "stale-intent" => Some(("source_mismatch", "warning")),
            "wrong-provider" => Some(("provider_mismatch", "warning")),
            _ => None,
        };
        let lifecycle = match std::fs::read_to_string(&fixture.supervisor.config.lifecycle_log) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => panic!("read supervisor lifecycle log: {error}"),
        };
        let refusal_events: Vec<serde_json::Value> = lifecycle
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .filter(|event: &serde_json::Value| event["event"] == "freshagent.native_name_refused")
            .collect();
        if let Some((reason, severity)) = expected_refusal {
            assert_eq!(
                refusal_events.len(),
                1,
                "{scenario}: the refused request is recorded in the supervisor lifecycle log"
            );
            assert_eq!(refusal_events[0]["data"]["reason"], reason, "{scenario}");
            assert_eq!(
                refusal_events[0]["data"]["severity"], severity,
                "{scenario}"
            );
        } else {
            assert!(
                refusal_events.is_empty(),
                "{scenario}: successful or pre-route requests do not record a refusal"
            );
        }
        assert_eq!(
            fixture
                .supervisor
                .registry
                .recovery_context(fixture.soul.clone())
                .await
                .unwrap()
                .fresh_agent,
            before,
            "metadata does not change launch/recovery settings"
        );
    }
}

#[tokio::test]
async fn native_name_lifecycle_busy_is_typed_and_fresh_retry_dispatches_once() {
    let fixture = running_fresh_provider_with_name(FreshProvider::Codex, None, "name-native").await;
    let view = fixture
        .supervisor
        .registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.soul_id == fixture.soul)
        .unwrap();
    let source = FreshAgentNativeNameSource {
        incarnation_id: view.incarnation_id.clone(),
        host_boot_id: view.host_boot_id.clone().unwrap(),
        execution_generation: view.execution_generation,
        intent_revision: view.intent_revision,
        native_session_id: "name-native".into(),
    };
    let (received, host) =
        fake_host_with_boot(&fixture.runtime_dir, false, source.host_boot_id.clone());
    let make_request = || {
        let mut request = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentNativeName(FreshAgentNativeNameRequest {
                soul_id: fixture.soul.clone(),
                source: source.clone(),
                codex_home: "/owning/codex".into(),
                operation: FreshAgentNativeNameOperation::Read,
                expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
            }),
        );
        request.auth = Some(SECRET.into());
        request
    };

    let lifecycle_lock = fixture.supervisor.lifecycle_lock(&fixture.soul).await;
    let busy_guard = lifecycle_lock.lock().await;
    let busy = fixture.supervisor.dispatch(make_request()).await;
    let AdminResult::FreshAgentNativeName(busy_reply) = busy.result.unwrap() else {
        panic!("native name request returned the wrong result")
    };
    assert_eq!(
        busy_reply,
        FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::LifecycleBusy),
        "the caller can distinguish a refusal before host dispatch"
    );
    assert!(
        received.lock().unwrap().is_empty(),
        "the busy request must not queue a host/native operation"
    );

    drop(busy_guard);
    let fresh = fixture.supervisor.dispatch(make_request()).await;
    let AdminResult::FreshAgentNativeName(fresh_reply) = fresh.result.unwrap() else {
        panic!("native name request returned the wrong result")
    };
    assert_eq!(
        fresh_reply,
        FreshAgentNativeNameReply::Title(Some("Native title".into()))
    );
    assert_eq!(
        received
            .lock()
            .unwrap()
            .iter()
            .filter(|command| matches!(command, HostCommand::FreshAgentNativeName { .. }))
            .count(),
        1,
        "only the fresh request after the lock release reaches the host"
    );
    host.abort();
    assert!(host.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn admin_model_catalog_uses_authenticated_current_host_and_preserves_recovery_settings() {
    for scenario in ["live", "stale-epoch", "replaced-boot", "wrong-provider"] {
        let fixture = running_fresh_provider(if scenario == "wrong-provider" {
            FreshProvider::Claude
        } else {
            FreshProvider::Codex
        })
        .await;
        let (received, host) =
            fake_host_with_boot_change(&fixture.runtime_dir, scenario == "replaced-boot");
        let before = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent;
        let epoch = fixture.supervisor.registry.control_epoch();
        let mut request = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::FreshAgentModelCatalog(FreshAgentModelCatalogRequest {
                soul_id: fixture.soul.clone(),
                cwd: Some("/bound/project".into()),
                expected_control_epoch: Some(if scenario == "stale-epoch" {
                    epoch + 1
                } else {
                    epoch
                }),
            }),
        );
        request.auth = Some(SECRET.into());
        let reply = fixture.supervisor.dispatch(request).await;
        host.abort();
        let _ = host.await;
        match scenario {
            "live" => assert!(
                matches!(reply.result.unwrap(),AdminResult::FreshAgentModelCatalog(value) if value[0]["id"]=="provider-current" && value[0]["defaultEffort"]=="ultra")
            ),
            "stale-epoch" => assert_eq!(
                reply.result.unwrap_err().code,
                RuntimeErrorCode::StaleControlEpoch
            ),
            "wrong-provider" => assert_eq!(
                reply.result.unwrap_err().code,
                RuntimeErrorCode::UnsupportedOperation
            ),
            _ => assert_eq!(
                reply.result.unwrap_err().code,
                RuntimeErrorCode::OwnershipMismatch
            ),
        }
        {
            let commands = received.lock().unwrap();
            if scenario == "stale-epoch" || scenario == "wrong-provider" {
                assert!(commands.is_empty());
            } else {
                assert_eq!(
                    commands
                        .iter()
                        .filter(|c| matches!(c, HostCommand::FreshAgentModelCatalog { .. }))
                        .count(),
                    1
                );
                assert!(commands.iter().all(|c| matches!(
                    c,
                    HostCommand::Hello { .. } | HostCommand::FreshAgentModelCatalog { .. }
                )));
                for command in commands.iter() {
                    if let HostCommand::FreshAgentModelCatalog { incarnation_id, .. } = command {
                        assert_eq!(incarnation_id, &fixture.incarnation);
                    }
                }
            }
        }
        let after = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .fresh_agent;
        assert_eq!(
            before, after,
            "catalog reads must never reconfigure recovery"
        );
    }
}
