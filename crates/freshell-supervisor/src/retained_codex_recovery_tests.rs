use super::*;
use crate::backend::{
    BackendCreated, BackendInspection, BackendRuntimeState, CreateRuntimeSpec, RuntimeBackend,
};
use crate::registry::OwnedRuntimeHandle;
use freshell_runtime_protocol::{
    FreshProvider, GrantId, NativeDispatchIdentity, NativeIdentityLaunch,
    NativeIdentityObservation, NativeIdentitySource, NativeReadinessReceipt, RecoverRequest,
    RecoveryOutcome, RecoveryState, RecoveryTrigger,
};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tokio::{net::UnixListener, sync::Notify, task::JoinHandle};

#[derive(Default)]
struct CountedBackend {
    ended: AtomicBool,
    stops: AtomicUsize,
    creates: AtomicUsize,
    hold_inspection: AtomicBool,
    inspecting: Notify,
    release_inspection: Notify,
}

#[async_trait::async_trait]
impl RuntimeBackend for CountedBackend {
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        if self.hold_inspection.load(Ordering::SeqCst) {
            self.inspecting.notify_one();
            self.release_inspection.notified().await;
        }
        Ok(BackendInspection {
            state: if self.ended.load(Ordering::SeqCst) {
                BackendRuntimeState::Exited
            } else {
                BackendRuntimeState::Running
            },
            configured_limits: handle.requested_limits(),
        })
    }
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::Unavailable(
            "controlled replacement unavailable".into(),
        ))
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("no replacement was created")
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.ended.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.request_stop(handle, 0).await
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(self.ended.load(Ordering::SeqCst))
    }
    async fn list_known(
        &self,
        _: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        panic!("observer uses exact handles")
    }
    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        Ok(handle.requested_limits())
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        Ok(())
    }
}

struct ControlledCodex {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    incarnation: IncarnationId,
    backend: Arc<CountedBackend>,
    source: Arc<std::sync::Mutex<NativeIdentityObservation>>,
    exited: Arc<AtomicBool>,
    inputs: Arc<AtomicUsize>,
    receipt_queries: Arc<AtomicUsize>,
    receipt_identity_mismatch: Arc<AtomicBool>,
    receipt_refused: Arc<AtomicBool>,
    terminal_ambiguous_receipt: Arc<AtomicBool>,
    lose_send_reply_once: Arc<AtomicBool>,
    native_prepares: Arc<AtomicUsize>,
    recovery_probes: Arc<AtomicUsize>,
    recovery_probe_blocked: Arc<AtomicBool>,
    prepares: Arc<AtomicUsize>,
    same_root_prepares: Arc<AtomicUsize>,
    compacts: Arc<AtomicUsize>,
    resolves: Arc<AtomicUsize>,
    statuses: Arc<AtomicUsize>,
    hold_ack: Arc<AtomicBool>,
    sending: Arc<Notify>,
    release: Arc<Notify>,
    transient_status: Arc<Notify>,
    status_observed: Arc<Notify>,
    status_busy: Arc<AtomicBool>,
    worker: Arc<AtomicBool>,
    capability: Arc<AtomicBool>,
    receipt_capability: Arc<AtomicBool>,
    same_root_capability: Arc<AtomicBool>,
    native_observation_missing: Arc<AtomicBool>,
    readiness_root_change: Arc<AtomicBool>,
    readiness_receipt: Arc<std::sync::Mutex<Option<NativeReadinessReceipt>>>,
    bad_ack: Arc<AtomicBool>,
    native_prepare_refuse: Arc<AtomicBool>,
    prepare_refuse: Arc<AtomicBool>,
    host_epoch: Arc<AtomicU64>,
    peer: JoinHandle<()>,
}

impl ControlledCodex {
    async fn new() -> Self {
        Self::with_registry_reopen(false).await
    }
    async fn with_registry_reopen(reopen: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
                .await;
        let runtime = root.path().join("host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let mut agent = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .fresh_agent
            .unwrap();
        agent.provider = FreshProvider::Codex;
        agent.session_type = "freshcodex".into();
        agent.runtime_variant = "codex-app-server".into();
        agent.fixture_transport = None;
        let boot = HostBootId::new();
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET provider='codex' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute("UPDATE incarnations SET runtime_dir=?1,execution_generation=1,host_boot_id=?2,grant_id=?3,fresh_agent_spec=?4,fixture_kind=NULL WHERE incarnation_id=?5",params![runtime.to_string_lossy(),boot.as_str(),GrantId::new().as_str(),serde_json::to_string(&agent).unwrap(),prepared.incarnation_id.as_str()]).unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let launch = NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: context.evidence_revision,
            execution_generation: 1,
            requested_native_session_id: Some("native-parent".into()),
        };
        registry
            .bind_native_identity_launch(launch.clone())
            .await
            .unwrap();
        let parent = NativeIdentityObservation {
            native_session_id: "native-parent".into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: launch.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                parent.clone(),
                registry.recovery_write_fence(soul.clone()).await.unwrap(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let candidate =
            crate::resume_catalog::exact_resume_candidate(&context, Some("native-parent"))
                .unwrap()
                .unwrap();
        registry
            .store_verified_resume_spec(soul.clone(), candidate)
            .await
            .unwrap();
        let current_context = registry.recovery_context(soul.clone()).await.unwrap();
        assert!(
            current_context.evidence_revision > launch.evidence_revision,
            "capturing resume evidence advances the registry fence without changing the host launch proof"
        );
        let source = Arc::new(std::sync::Mutex::new(parent));
        let exited = Arc::new(AtomicBool::new(true));
        let inputs = Arc::new(AtomicUsize::new(0));
        let receipt_queries = Arc::new(AtomicUsize::new(0));
        let receipt_identity_mismatch = Arc::new(AtomicBool::new(false));
        let receipt_refused = Arc::new(AtomicBool::new(false));
        let terminal_ambiguous_receipt = Arc::new(AtomicBool::new(false));
        let lose_send_reply_once = Arc::new(AtomicBool::new(false));
        let send_receipt = Arc::new(std::sync::Mutex::new(
            None::<(RequestId, NativeDispatchIdentity)>,
        ));
        let native_prepares = Arc::new(AtomicUsize::new(0));
        let recovery_probes = Arc::new(AtomicUsize::new(0));
        let recovery_probe_blocked = Arc::new(AtomicBool::new(false));
        let prepares = Arc::new(AtomicUsize::new(0));
        let same_root_prepares = Arc::new(AtomicUsize::new(0));
        let compacts = Arc::new(AtomicUsize::new(0));
        let resolves = Arc::new(AtomicUsize::new(0));
        let statuses = Arc::new(AtomicUsize::new(0));
        let hold_ack = Arc::new(AtomicBool::new(false));
        let sending = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let transient_status = Arc::new(Notify::new());
        let status_observed = Arc::new(Notify::new());
        let status_busy = Arc::new(AtomicBool::new(false));
        let worker = Arc::new(AtomicBool::new(true));
        let capability = Arc::new(AtomicBool::new(true));
        let receipt_capability = Arc::new(AtomicBool::new(true));
        let same_root_capability = Arc::new(AtomicBool::new(true));
        let native_observation_missing = Arc::new(AtomicBool::new(false));
        let readiness_root_change = Arc::new(AtomicBool::new(false));
        let readiness_receipt = Arc::new(std::sync::Mutex::new(None));
        let bad_ack = Arc::new(AtomicBool::new(false));
        let native_prepare_refuse = Arc::new(AtomicBool::new(false));
        let prepare_refuse = Arc::new(AtomicBool::new(false));
        let host_epoch = Arc::new(AtomicU64::new(registry.control_epoch()));
        let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let peer = {
            let source = source.clone();
            let exited = exited.clone();
            let inputs = inputs.clone();
            let receipt_queries = receipt_queries.clone();
            let receipt_identity_mismatch = receipt_identity_mismatch.clone();
            let receipt_refused = receipt_refused.clone();
            let terminal_ambiguous_receipt = terminal_ambiguous_receipt.clone();
            let lose_send_reply_once = lose_send_reply_once.clone();
            let send_receipt = send_receipt.clone();
            let native_prepares = native_prepares.clone();
            let recovery_probes = recovery_probes.clone();
            let recovery_probe_blocked = recovery_probe_blocked.clone();
            let prepares = prepares.clone();
            let same_root_prepares = same_root_prepares.clone();
            let compacts = compacts.clone();
            let resolves = resolves.clone();
            let statuses = statuses.clone();
            let hold_ack = hold_ack.clone();
            let sending = sending.clone();
            let release = release.clone();
            let transient_status = transient_status.clone();
            let status_observed = status_observed.clone();
            let status_busy = status_busy.clone();
            let worker = worker.clone();
            let capability = capability.clone();
            let receipt_capability = receipt_capability.clone();
            let same_root_capability = same_root_capability.clone();
            let native_observation_missing = native_observation_missing.clone();
            let readiness_root_change = readiness_root_change.clone();
            let readiness_receipt = readiness_receipt.clone();
            let bad_ack = bad_ack.clone();
            let native_prepare_refuse = native_prepare_refuse.clone();
            let prepare_refuse = prepare_refuse.clone();
            let host_epoch = host_epoch.clone();
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let source = source.clone();
                    let exited = exited.clone();
                    let inputs = inputs.clone();
                    let receipt_queries = receipt_queries.clone();
                    let receipt_identity_mismatch = receipt_identity_mismatch.clone();
                    let receipt_refused = receipt_refused.clone();
                    let terminal_ambiguous_receipt = terminal_ambiguous_receipt.clone();
                    let lose_send_reply_once = lose_send_reply_once.clone();
                    let send_receipt = send_receipt.clone();
                    let native_prepares = native_prepares.clone();
                    let recovery_probes = recovery_probes.clone();
                    let recovery_probe_blocked = recovery_probe_blocked.clone();
                    let prepares = prepares.clone();
                    let same_root_prepares = same_root_prepares.clone();
                    let compacts = compacts.clone();
                    let resolves = resolves.clone();
                    let statuses = statuses.clone();
                    let hold_ack = hold_ack.clone();
                    let sending = sending.clone();
                    let release = release.clone();
                    let boot = boot.clone();
                    let launch = launch.clone();
                    let transient_status = transient_status.clone();
                    let status_observed = status_observed.clone();
                    let status_busy = status_busy.clone();
                    let worker = worker.clone();
                    let capability = capability.clone();
                    let receipt_capability = receipt_capability.clone();
                    let same_root_capability = same_root_capability.clone();
                    let native_observation_missing = native_observation_missing.clone();
                    let readiness_root_change = readiness_root_change.clone();
                    let readiness_receipt = readiness_receipt.clone();
                    let bad_ack = bad_ack.clone();
                    let native_prepare_refuse = native_prepare_refuse.clone();
                    let prepare_refuse = prepare_refuse.clone();
                    let host_epoch = host_epoch.clone();
                    tokio::spawn(async move {
                        let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                        if !matches!(request.body, HostCommand::Hello { .. }) {
                            assert_eq!(
                                request.auth,
                                Some(host_proof(
                                    b"synthetic-secret",
                                    "command-auth",
                                    &boot,
                                    &launch.incarnation_id
                                ))
                            );
                        }
                        let receipt_only_request = matches!(
                            &request.body,
                            HostCommand::FreshAgentSend {
                                receipt_only: true,
                                ..
                            }
                        );
                        let mut drop_reply = false;
                        let result = match request.body {
                            HostCommand::Hello {
                                incarnation_id,
                                challenge,
                            } => HostResult::Hello {
                                proof: host_proof(
                                    b"synthetic-secret",
                                    &challenge,
                                    &boot,
                                    &incarnation_id,
                                ),
                                host_boot_id: boot.clone(),
                                capabilities: {
                                    let mut values = vec![
                                        "owned-provider-config-v1".into(),
                                        "provider-store-probe-v1".into(),
                                        "native-identity-observation-v1".into(),
                                        "fresh-agent-codex-dispatch-recovery-v1".into(),
                                        HOST_CAPABILITY_NATIVE_READINESS_RECEIPT_V1.into(),
                                    ];
                                    if receipt_capability.load(Ordering::SeqCst) {
                                        values.push(HOST_CAPABILITY_CODEX_SEND_RECEIPT_V1.into());
                                    }
                                    if capability.load(Ordering::SeqCst) {
                                        values.push("fresh-agent-codex-recovery-source-v1".into());
                                    }
                                    if same_root_capability.load(Ordering::SeqCst) {
                                        values.push(
                                            "fresh-agent-codex-same-root-readiness-v1".into(),
                                        );
                                    }
                                    values
                                },
                                effective_limits: context.requested_limits,
                            },
                            HostCommand::Status { .. } => {
                                statuses.fetch_add(1, Ordering::SeqCst);
                                status_observed.notify_one();
                                let temporarily_busy = status_busy.load(Ordering::SeqCst)
                                    && hold_ack.load(Ordering::SeqCst);
                                let ended = exited.load(Ordering::SeqCst) || temporarily_busy;
                                let observation = source.lock().unwrap().clone();
                                HostResult::Status {
                                    fresh_agent_recovery_source: if temporarily_busy
                                        || (hold_ack.load(Ordering::SeqCst)
                                            && inputs.load(Ordering::SeqCst) > 0)
                                    {
                                        transient_status.notify_one();
                                        None
                                    } else {
                                        ended.then(|| observation.clone())
                                    },
                                    host_boot_id: boot,
                                    worker_pid: worker.load(Ordering::SeqCst).then_some(123),
                                    worker_launch_count: 1,
                                    max_control_epoch: host_epoch.load(Ordering::SeqCst),
                                    max_execution_generation: 1,
                                    fixture_evidence: serde_json::json!({"workload":"fresh-agent"}),
                                    exited: ended,
                                    native_session_id: (!ended)
                                        .then(|| observation.native_session_id.clone()),
                                    native_identity_observation: (!ended
                                        && !native_observation_missing.load(Ordering::SeqCst))
                                    .then_some(observation),
                                    native_readiness_receipt: readiness_receipt
                                        .lock()
                                        .unwrap()
                                        .clone(),
                                    opencode_transfer_receipt: None,
                                    opencode_adoption: Default::default(),
                                }
                            }
                            HostCommand::FreshAgentSend {
                                request_id,
                                text,
                                settings,
                                checkpoint_logical_attempt_id,
                                receipt_only,
                                ..
                            } => {
                                if request_id.as_str() == "receipt-only-checkpointed" {
                                    assert_eq!(text, "original public reference input");
                                    assert!(settings
                                        .as_ref()
                                        .and_then(|settings| settings.cwd.as_deref())
                                        .is_some_and(|cwd| std::path::Path::new(cwd).is_dir()));
                                    assert_eq!(
                                        settings
                                            .as_ref()
                                            .and_then(|settings| settings.model.as_deref()),
                                        Some("gpt-5-codex")
                                    );
                                    assert_eq!(
                                        settings.as_ref().and_then(|settings| settings
                                            .effort
                                            .as_ref()
                                            .and_then(Option::as_deref)),
                                        Some("high")
                                    );
                                    assert_eq!(
                                        checkpoint_logical_attempt_id.as_deref(),
                                        Some("logical-attempt-9")
                                    );
                                }
                                if receipt_only {
                                    receipt_queries.fetch_add(1, Ordering::SeqCst);
                                    if terminal_ambiguous_receipt.load(Ordering::SeqCst) {
                                        HostResult::FreshAgentCommand {
                                            state: CommandState::Ambiguous,
                                            claude_fork: None,
                                            native_session_id: None,
                                            native_identity: None,
                                        }
                                    } else {
                                        match send_receipt.lock().unwrap().clone() {
                                            Some((recorded_request, mut identity))
                                                if recorded_request == request_id =>
                                            {
                                                // The host commits its actor receipt
                                                // before replying, so the accepted
                                                // Codex process is current again.
                                                exited.store(false, Ordering::SeqCst);
                                                if receipt_identity_mismatch.load(Ordering::SeqCst)
                                                {
                                                    identity.previous_native_session_id =
                                                        "foreign-receipt-source".into();
                                                }
                                                HostResult::FreshAgentCommand {
                                                    state: CommandState::ProviderAcked,
                                                    claude_fork: None,
                                                    native_session_id: Some(
                                                        identity.native_session_id.clone(),
                                                    ),
                                                    native_identity: Some(identity),
                                                }
                                            }
                                            _ => HostResult::FreshAgentCommand {
                                                state: CommandState::Ambiguous,
                                                claude_fork: None,
                                                native_session_id: None,
                                                native_identity: None,
                                            },
                                        }
                                    }
                                } else {
                                    inputs.fetch_add(1, Ordering::SeqCst);
                                    sending.notify_one();
                                    if hold_ack.load(Ordering::SeqCst) {
                                        release.notified().await;
                                    }
                                    let previous = source.lock().unwrap().native_session_id.clone();
                                    let native_session_id =
                                        if readiness_root_change.load(Ordering::SeqCst) {
                                            previous.clone()
                                        } else {
                                            let mut observation = source.lock().unwrap();
                                            observation.native_session_id = "native-child".into();
                                            observation.evidence_revision =
                                                launch.evidence_revision.checked_add(1).expect(
                                                    "synthetic Codex identity revision has room",
                                                );
                                            "native-child".into()
                                        };
                                    exited.store(false, Ordering::SeqCst);
                                    let identity = NativeDispatchIdentity {
                                        previous_native_session_id: if bad_ack
                                            .load(Ordering::SeqCst)
                                        {
                                            "foreign-ack-source".into()
                                        } else {
                                            previous
                                        },
                                        native_session_id,
                                        pending_naming_handle: None,
                                    };
                                    *send_receipt.lock().unwrap() =
                                        Some((request_id.clone(), identity.clone()));
                                    if lose_send_reply_once.swap(false, Ordering::SeqCst) {
                                        // The provider accepted the request and then exited before
                                        // the supervisor could receive the host reply. The host
                                        // worker itself remains available to answer a receipt-only
                                        // query.
                                        exited.store(true, Ordering::SeqCst);
                                        drop_reply = true;
                                    }
                                    HostResult::FreshAgentCommand {
                                        state: CommandState::ProviderAcked,
                                        claude_fork: None,
                                        native_session_id: Some(identity.native_session_id.clone()),
                                        native_identity: Some(identity),
                                    }
                                }
                            }
                            HostCommand::FreshAgentPrepareNative { .. } => {
                                native_prepares.fetch_add(1, Ordering::SeqCst);
                                if native_prepare_refuse.swap(false, Ordering::SeqCst) {
                                    HostResult::FreshAgentCommand {
                                        state: CommandState::Cancelled,
                                        claude_fork: None,
                                        native_identity: None,
                                        native_session_id: Some(
                                            source.lock().unwrap().native_session_id.clone(),
                                        ),
                                    }
                                } else if let Some(receipt) =
                                    readiness_receipt.lock().unwrap().clone()
                                {
                                    exited.store(false, Ordering::SeqCst);
                                    HostResult::FreshAgentCommand {
                                        state: CommandState::ProviderAcked,
                                        claude_fork: None,
                                        native_identity: Some(receipt.identity),
                                        native_session_id: Some(
                                            source.lock().unwrap().native_session_id.clone(),
                                        ),
                                    }
                                } else {
                                    let native_identity =
                                        if readiness_root_change.load(Ordering::SeqCst) {
                                            let previous =
                                                source.lock().unwrap().native_session_id.clone();
                                            let mut observation = source.lock().unwrap();
                                            observation.native_session_id =
                                                "native-readiness-child".into();
                                            observation.evidence_revision =
                                                launch.evidence_revision.checked_add(1).expect(
                                                    "synthetic Codex readiness revision has room",
                                                );
                                            Some(NativeDispatchIdentity {
                                                previous_native_session_id: previous,
                                                native_session_id: "native-readiness-child".into(),
                                                pending_naming_handle: None,
                                            })
                                        } else {
                                            None
                                        };
                                    exited.store(false, Ordering::SeqCst);
                                    HostResult::FreshAgentCommand {
                                        state: CommandState::Completed,
                                        claude_fork: None,
                                        native_identity,
                                        native_session_id: Some(
                                            source.lock().unwrap().native_session_id.clone(),
                                        ),
                                    }
                                }
                            }
                            HostCommand::FreshAgentPrepareSameRootNative { .. } => {
                                same_root_prepares.fetch_add(1, Ordering::SeqCst);
                                prepares.fetch_add(1, Ordering::SeqCst);
                                native_observation_missing.store(false, Ordering::SeqCst);
                                if prepare_refuse.load(Ordering::SeqCst) {
                                    write_frame(
                                        &mut socket,
                                        &HostReply {
                                            request_id: request.request_id,
                                            result: Err(RuntimeError::new(
                                                RuntimeErrorCode::RecoveryBlocked,
                                                "same-root history is unavailable",
                                            )),
                                        },
                                    )
                                    .await
                                    .unwrap();
                                    return;
                                }
                                sending.notify_one();
                                if hold_ack.load(Ordering::SeqCst) {
                                    release.notified().await;
                                }
                                exited.store(false, Ordering::SeqCst);
                                HostResult::FreshAgentCommand {
                                    state: CommandState::ProviderAcked,
                                    claude_fork: None,
                                    native_identity: None,
                                    native_session_id: Some(
                                        source.lock().unwrap().native_session_id.clone(),
                                    ),
                                }
                            }
                            HostCommand::FreshAgentCompact { .. } => {
                                assert!(!exited.load(Ordering::SeqCst));
                                compacts.fetch_add(1, Ordering::SeqCst);
                                sending.notify_one();
                                if hold_ack.load(Ordering::SeqCst) {
                                    release.notified().await;
                                }
                                HostResult::FreshAgentCommand {
                                    state: CommandState::ProviderAcked,
                                    claude_fork: None,
                                    native_identity: None,
                                    native_session_id: Some(
                                        source.lock().unwrap().native_session_id.clone(),
                                    ),
                                }
                            }
                            HostCommand::FreshAgentResolve { .. } => {
                                resolves.fetch_add(1, Ordering::SeqCst);
                                HostResult::FreshAgentCommand {
                                    state: CommandState::Completed,
                                    claude_fork: None,
                                    native_identity: None,
                                    native_session_id: Some(
                                        source.lock().unwrap().native_session_id.clone(),
                                    ),
                                }
                            }
                            HostCommand::ProbeRecovery {
                                resume_spec: Some(resume_spec),
                                ..
                            } => {
                                recovery_probes.fetch_add(1, Ordering::SeqCst);
                                let probe = if recovery_probe_blocked.load(Ordering::SeqCst) {
                                    freshell_runtime_protocol::RecoveryProbe::Blocked {
                                        path: freshell_runtime_protocol::RecoveryPath::NativeResume,
                                        reason: freshell_runtime_protocol::RecoveryBlockReason::ImplementationUnavailable,
                                        retry_hint: freshell_runtime_protocol::RetryHint {
                                            automatic_after_ms: None,
                                            manual_retry: true,
                                            repair: None,
                                        },
                                        evidence: vec!["exact native history is unavailable".into()],
                                    }
                                } else {
                                    freshell_runtime_protocol::RecoveryProbe::ResumeReady {
                                        evidence_revision: resume_spec.evidence_revision,
                                        resume_spec,
                                    }
                                };
                                HostResult::RecoveryProbe(probe)
                            }
                            HostCommand::Stop { .. } => HostResult::Stopped,
                            other => panic!("unexpected controlled Codex command {other:?}"),
                        };
                        if !drop_reply {
                            write_frame(
                                &mut socket,
                                &HostReply {
                                    request_id: request.request_id,
                                    result: if receipt_only_request
                                        && receipt_refused.swap(false, Ordering::SeqCst)
                                    {
                                        Err(freshell_runtime_protocol::RuntimeError::new(
                                            freshell_runtime_protocol::RuntimeErrorCode::HostUnreachable,
                                            "hosted fresh-agent command failed",
                                        )
                                        .with_fresh_agent_send_diagnostic(
                                            freshell_runtime_protocol::FreshAgentSendDiagnostic {
                                                outcome: freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Refused,
                                                // The persisted host command record stores the
                                                // outcome, but not provider-specific refusal text.
                                                message: None,
                                            },
                                        ))
                                    } else {
                                        Ok(result)
                                    },
                                },
                            )
                            .await
                            .unwrap();
                        }
                    });
                }
            })
        };
        let registry = if reopen {
            let registry_root = registry.registry_root().to_path_buf();
            drop(registry);
            Registry::open(registry_root, None).unwrap()
        } else {
            registry
        };
        let backend = Arc::new(CountedBackend::default());
        let supervisor = Supervisor::new(
            registry,
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.path().join("runtime"),
                control_socket_path: root.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "retained-codex".into(),
                control_secret: "synthetic-secret".into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        Self {
            _root: root,
            supervisor,
            soul,
            incarnation: prepared.incarnation_id,
            backend,
            source,
            exited,
            inputs,
            receipt_queries,
            receipt_identity_mismatch,
            receipt_refused,
            terminal_ambiguous_receipt,
            lose_send_reply_once,
            native_prepares,
            recovery_probes,
            recovery_probe_blocked,
            prepares,
            same_root_prepares,
            compacts,
            resolves,
            statuses,
            hold_ack,
            sending,
            release,
            transient_status,
            status_observed,
            status_busy,
            worker,
            capability,
            receipt_capability,
            same_root_capability,
            native_observation_missing,
            readiness_root_change,
            readiness_receipt,
            bad_ack,
            native_prepare_refuse,
            prepare_refuse,
            host_epoch,
            peer,
        }
    }
    async fn send(&self, request_id: RequestId) -> Result<AdminResult, RuntimeError> {
        self.send_with_checkpoint(request_id, None, None).await
    }
    async fn send_with_checkpoint(
        &self,
        request_id: RequestId,
        checkpoint_logical_attempt_id: Option<String>,
        settings: Option<freshell_runtime_protocol::FreshAgentTurnSettings>,
    ) -> Result<AdminResult, RuntimeError> {
        self.supervisor
            .dispatch(Envelope {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id,
                role: ControlRole::Web,
                auth: Some("synthetic-secret".into()),
                body: AdminCommand::FreshAgentSend(
                    freshell_runtime_protocol::FreshAgentSendRequest {
                        soul_id: self.soul.clone(),
                        text: "original public reference input".into(),
                        settings,
                        expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
                        checkpoint_logical_attempt_id,
                    },
                ),
            })
            .await
            .result
    }
    async fn reconcile_send(
        &self,
        request_id: RequestId,
        checkpoint_logical_attempt_id: Option<String>,
        settings: Option<freshell_runtime_protocol::FreshAgentTurnSettings>,
    ) -> Result<AdminResult, RuntimeError> {
        self.supervisor
            .dispatch(Envelope {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id,
                role: ControlRole::Web,
                auth: Some("synthetic-secret".into()),
                body: AdminCommand::FreshAgentSendReconcile(
                    freshell_runtime_protocol::FreshAgentSendRequest {
                        soul_id: self.soul.clone(),
                        text: "original public reference input".into(),
                        settings,
                        expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
                        checkpoint_logical_attempt_id,
                    },
                ),
            })
            .await
            .result
    }
    async fn compact(&self) -> Result<AdminResult, RuntimeError> {
        self.supervisor
            .dispatch(Envelope {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: RequestId::new(),
                role: ControlRole::Web,
                auth: Some("synthetic-secret".into()),
                body: AdminCommand::FreshAgentCompact(
                    freshell_runtime_protocol::FreshAgentCompactRequest {
                        soul_id: self.soul.clone(),
                        instructions: None,
                        cwd: None,
                        expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
                    },
                ),
            })
            .await
            .result
    }
    fn attempts(&self) -> u64 {
        Connection::open(self.supervisor.registry.database_path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recovery_attempts", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
    async fn assert_retained(&self) {
        let context = self
            .supervisor
            .registry
            .recovery_context(self.soul.clone())
            .await
            .unwrap();
        assert_eq!(context.prior_handle.incarnation_id(), &self.incarnation);
        let writer: (String, String) = Connection::open(self.supervisor.registry.database_path())
            .unwrap()
            .query_row(
                "SELECT native_session_id,incarnation_id FROM writer_claims WHERE soul_id=?1",
                [self.soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            Some(writer.0.as_str()),
            context.native_session_id.as_deref()
        );
        assert_eq!(writer.1, self.incarnation.as_str());
        assert_eq!(
            self.backend.stops.load(Ordering::SeqCst),
            0,
            "eligible actor never stops its container"
        );
        assert_eq!(
            self.backend.creates.load(Ordering::SeqCst),
            0,
            "eligible actor never replaces its container"
        );
        assert_eq!(
            self.attempts(),
            0,
            "retained actor classification spends no recovery attempt"
        );
    }
}

#[tokio::test]
async fn registry_reopen_observer_retains_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    assert_eq!(
        fixture.host_epoch.load(Ordering::SeqCst) + 1,
        fixture.supervisor.registry.control_epoch()
    );
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
}

#[tokio::test]
async fn registry_reopen_public_send_recovers_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.send(RequestId::new()).await.unwrap();
    fixture.send(RequestId::new()).await.unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn registry_reopen_public_compact_prepares_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.compact().await.unwrap();
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn newer_host_controller_refuses_retained_recovery() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.host_epoch.store(
        fixture.supervisor.registry.control_epoch() + 1,
        Ordering::SeqCst,
    );
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert!(fixture.compact().await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 0);
    fixture.supervisor.observe_once().await.unwrap();
    assert_eq!(fixture.attempts(), 1);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn backend_inspection_does_not_block_public_send() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture
        .backend
        .hold_inspection
        .store(true, Ordering::SeqCst);
    let observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    fixture.backend.inspecting.notified().await;
    let result = tokio::time::timeout(Duration::from_secs(2), fixture.send(RequestId::new())).await;
    fixture
        .backend
        .hold_inspection
        .store(false, Ordering::SeqCst);
    fixture.backend.release_inspection.notify_one();
    observer.await.unwrap().unwrap();
    result
        .expect("public SEND must complete while backend inspection remains held")
        .unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn backend_inspection_rechecks_current_owner_before_host_calls() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture
        .backend
        .hold_inspection
        .store(true, Ordering::SeqCst);
    let observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    fixture.backend.inspecting.notified().await;
    fixture
        .supervisor
        .registry
        .begin_stop(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .backend
        .hold_inspection
        .store(false, Ordering::SeqCst);
    fixture.backend.release_inspection.notify_one();
    observer.await.unwrap().unwrap();
    assert_eq!(
        fixture.statuses.load(Ordering::SeqCst),
        0,
        "stale backend observation must not contact the revoked owner"
    );
    assert_eq!(fixture.attempts(), 0);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn observer_logs_retention_transitions_once_per_state() {
    let fixture = ControlledCodex::new().await;
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
    }
    fixture.send(RequestId::new()).await.unwrap();
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
    }
    let events = std::fs::read_to_string(&fixture.supervisor.config.lifecycle_log).unwrap();
    let transitions = events
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| event["event"] == "supervisor.runtime_observer.retained_codex_actor")
        .collect::<Vec<_>>();
    assert_eq!(
        transitions.len(),
        2,
        "one entry and one exit, without per-tick repetition"
    );
    assert_eq!(transitions[0]["data"]["retained"], true);
    assert_eq!(transitions[1]["data"]["retained"], false);
    for event in transitions {
        assert_eq!(event["data"]["severity"], "info");
        assert_eq!(event["data"]["soulId"], fixture.soul.as_str());
        assert_eq!(event["data"]["incarnationId"], fixture.incarnation.as_str());
        assert_eq!(event["data"]["nativeSessionId"], "native-parent");
    }
    fixture.assert_retained().await;
}
impl Drop for ControlledCodex {
    fn drop(&mut self) {
        self.peer.abort();
    }
}

#[tokio::test]
async fn public_compact_prepares_retained_codex_same_root_without_input_or_replacement() {
    let fixture = ControlledCodex::new().await;
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert!(matches!(
        fixture.compact().await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));
    fixture.compact().await.unwrap();
    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(before.native_session_id, after.native_session_id);
    assert_eq!(before.write_fence(), after.write_fence());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 2);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn retained_codex_native_exit_requires_a_fresh_store_probe_before_reattaching() {
    let fixture = ControlledCodex::new().await;
    fixture.recovery_probe_blocked.store(true, Ordering::SeqCst);

    let probe = fixture
        .supervisor
        .probe_recovery_locked(fixture.soul.clone())
        .await
        .unwrap();

    assert!(
        matches!(
            probe,
            freshell_runtime_protocol::RecoveryProbe::Blocked {
                reason: freshell_runtime_protocol::RecoveryBlockReason::ImplementationUnavailable,
                ..
            }
        ),
        "an in-memory retained actor cannot prove its archived native history still exists: {probe:?}"
    );
    assert_eq!(
        fixture.recovery_probes.load(Ordering::SeqCst),
        1,
        "reattachment must be gated on a fresh exact native-store probe"
    );
    fixture.assert_retained().await;
}

#[tokio::test]
async fn public_compact_prepares_live_codex_same_root_when_current_proof_is_missing() {
    let fixture = ControlledCodex::new().await;
    fixture.exited.store(false, Ordering::SeqCst);
    fixture
        .native_observation_missing
        .store(true, Ordering::SeqCst);

    assert!(matches!(
        fixture.compact().await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));

    assert_eq!(fixture.same_root_prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent"),
        "live same-root readiness must preserve the current Codex identity"
    );
}

#[tokio::test]
async fn public_compact_does_not_run_codex_readiness_for_another_provider() {
    let fixture = ControlledCodex::new().await;
    fixture.exited.store(false, Ordering::SeqCst);
    fixture
        .native_observation_missing
        .store(true, Ordering::SeqCst);

    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let mut agent = context.fresh_agent.unwrap();
    agent.provider = FreshProvider::Opencode;
    agent.session_type = "freshopencode".into();
    agent.runtime_variant = "freshopencode".into();
    let conn = Connection::open(fixture.supervisor.registry.database_path()).unwrap();
    conn.execute(
        "UPDATE souls SET provider='opencode' WHERE soul_id=?1",
        [fixture.soul.as_str()],
    )
    .unwrap();
    conn.execute(
        "UPDATE incarnations SET fresh_agent_spec=?1 WHERE incarnation_id=?2",
        params![
            serde_json::to_string(&agent).unwrap(),
            fixture.incarnation.as_str()
        ],
    )
    .unwrap();

    let error = fixture.compact().await.unwrap_err();
    assert_eq!(
        error.code,
        RuntimeErrorCode::RecoveryBlocked,
        "the synthetic OpenCode fixture has no committed native identity"
    );
    assert_eq!(
        fixture.same_root_prepares.load(Ordering::SeqCst),
        0,
        "Codex same-root readiness must not be sent for an OpenCode soul"
    );
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn public_compact_uses_exact_store_readiness_without_same_root_support() {
    let fixture = ControlledCodex::new().await;
    fixture.same_root_capability.store(false, Ordering::SeqCst);

    assert!(matches!(
        fixture.compact().await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));

    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent"),
        "readiness must preserve the exact retained Codex root"
    );
}

#[tokio::test]
async fn observer_retains_eligible_codex_actor_without_attempts_then_host_loss_uses_supervisor() {
    let fixture = ControlledCodex::new().await;
    assert!(matches!(
        fixture
            .supervisor
            .probe_recovery_locked(fixture.soul.clone())
            .await
            .unwrap(),
        freshell_runtime_protocol::RecoveryProbe::ReattachReady { .. }
    ));
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
        fixture.assert_retained().await;
    }
    fixture.peer.abort();
    fixture.backend.ended.store(true, Ordering::SeqCst);
    fixture.supervisor.observe_once().await.unwrap();
    assert!(
        fixture.attempts() > 0,
        "whole host loss must return to supervisor recovery"
    );
    assert_eq!(
        fixture.backend.creates.load(Ordering::SeqCst),
        1,
        "one bounded supervisor replacement attempt"
    );
}

#[tokio::test]
async fn public_send_recovers_retained_codex_source_and_commits_before_second_input() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
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
    assert!(
        fixture
            .supervisor
            .retained_codex_host_eligible(&before, &host, &status)
            .await
            .unwrap(),
        "initial retained root should satisfy the exact SEND admission checks"
    );
    assert!(
        codex_dispatch_recovery_is_bound(&before, &active, &host, &status),
        "initial retained source should also satisfy the stricter recovery-send binding"
    );
    let registry_source = fixture
        .supervisor
        .registry
        .codex_dispatch_recovery_source(fixture.soul.clone())
        .await
        .unwrap()
        .unwrap_or_else(|| {
            panic!(
                "the registry should mint an exact retained-send source; recovery state is {:?}",
                before.recovery_state
            )
        });
    assert!(registry_source.matches_context(&before));
    assert!(registry_source.matches_host(&host.host_boot_id, status.max_execution_generation));
    let send = fixture.send(RequestId::new()).await;
    assert!(
        matches!(
            &send,
            Ok(AdminResult::FreshAgentCommand {
                state: CommandState::ProviderAcked
            })
        ),
        "initial send returned {send:?}; lifecycle: {}",
        std::fs::read_to_string(fixture._root.path().join("lifecycle.jsonl")).unwrap_or_default()
    );
    fixture.assert_retained().await;
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(context.native_session_id.as_deref(), Some("native-child"));
    assert_eq!(
        fixture.native_prepares.load(Ordering::SeqCst),
        0,
        "the retained host's guarded SEND owns native recovery; no separate prepare may run"
    );
    assert_eq!(
        fixture.source.lock().unwrap().evidence_revision,
        context
            .native_identity_launch
            .as_ref()
            .expect("committed child retains its launch binding")
            .evidence_revision,
        "the host observation must use the revision committed with the child root"
    );
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
    assert!(
        crate::recovery::current_native_observation(&context, &status).is_some(),
        "accepted Codex dispatch must publish the current committed identity"
    );
    fixture.supervisor.observe_once().await.unwrap();
    let second_send = fixture.send(RequestId::new()).await;
    assert!(
        matches!(
            &second_send,
            Ok(AdminResult::FreshAgentCommand {
                state: CommandState::ProviderAcked
            })
        ),
        "second send returned {second_send:?}; lifecycle: {}",
        std::fs::read_to_string(fixture._root.path().join("lifecycle.jsonl")).unwrap_or_default()
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture.recovery_probes.load(Ordering::SeqCst),
        1,
        "the observer performs one bounded provider check after the retained SEND"
    );
    fixture.assert_retained().await;
}

#[tokio::test]
async fn public_send_uses_retained_codex_source_without_a_separate_prepare() {
    let fixture = ControlledCodex::new().await;
    fixture.readiness_root_change.store(true, Ordering::SeqCst);
    let request_id = RequestId::new();

    assert!(matches!(
        fixture.send(request_id.clone()).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(context.native_session_id.as_deref(), Some("native-parent"));
    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);

    assert!(matches!(
        fixture.send(request_id).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Completed
        }
    ));
    assert_eq!(
        fixture.inputs.load(Ordering::SeqCst),
        1,
        "a completed SEND is replayed from its journal without repeating the provider input"
    );
}

#[tokio::test]
async fn lost_retained_codex_send_reply_is_reconciled_from_host_receipt_without_resend() {
    let fixture = ControlledCodex::new().await;
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::new();

    assert!(matches!(
        fixture
        .send(request_id.clone())
        .await
        .unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Completed
        }
    ), "receipt recovery should finish the original public SEND request, even when the provider exits before its reply is queried");
    assert_eq!(
        fixture.inputs.load(Ordering::SeqCst),
        1,
        "the request must reach the host exactly once; lifecycle: {}",
        std::fs::read_to_string(fixture._root.path().join("lifecycle.jsonl")).unwrap_or_default()
    );
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-child"),
        "the original SEND should commit the receipt-backed root before returning"
    );

    assert!(matches!(
        fixture.send(request_id.clone()).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Completed
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-child")
    );
    assert!(matches!(
        fixture.send(request_id).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Completed
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn explicit_receipt_reconcile_settles_ambiguous_send_without_dispatching_again() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("receipt-only-checkpointed").unwrap();
    let checkpoint_logical_attempt_id = Some("logical-attempt-9".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        effort: Some(Some("high".into())),
        collaboration_mode: None,
        permission_mode: None,
        sandbox: None,
    });

    let original_send_error = fixture
        .send_with_checkpoint(
            request_id.clone(),
            checkpoint_logical_attempt_id.clone(),
            settings.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(original_send_error.code, RuntimeErrorCode::HostUnreachable);
    let settings_correlation = serde_json::to_vec(&(
        settings.as_ref(),
        checkpoint_logical_attempt_id.as_deref().unwrap(),
    ))
    .unwrap();
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id.clone(),
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Ambiguous)
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 0);

    fixture.receipt_capability.store(true, Ordering::SeqCst);
    assert!(matches!(
        fixture
            .reconcile_send(request_id, checkpoint_logical_attempt_id, settings,)
            .await
            .unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Completed
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    fixture.peer.abort();
}

#[tokio::test]
async fn mismatched_receipt_stays_ambiguous_and_records_safe_lifecycle_event() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("receipt-identity-mismatch").unwrap();
    let checkpoint_logical_attempt_id = Some("logical-attempt-identity-mismatch".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });

    let original_send_error = fixture
        .send_with_checkpoint(
            request_id.clone(),
            checkpoint_logical_attempt_id.clone(),
            settings.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(original_send_error.code, RuntimeErrorCode::HostUnreachable);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);

    fixture.receipt_capability.store(true, Ordering::SeqCst);
    fixture
        .receipt_identity_mismatch
        .store(true, Ordering::SeqCst);
    assert!(matches!(
        fixture
            .reconcile_send(request_id.clone(), checkpoint_logical_attempt_id, settings)
            .await
            .unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Ambiguous
        }
    ));

    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    let lifecycle = std::fs::read_to_string(&fixture.supervisor.config.lifecycle_log).unwrap();
    assert!(lifecycle.contains("fresh_agent.codex_send_receipt_reconcile"));
    assert!(lifecycle.contains("native_identity_mismatch"));
    assert!(lifecycle.contains(request_id.as_str()));
    assert!(!lifecycle.contains("original public reference input"));
    assert!(!lifecycle.contains("gpt-5-codex"));
    fixture.peer.abort();
}

#[tokio::test]
async fn receipt_reconcile_distinguishes_missing_or_queued_journals_without_host_receipts() {
    let fixture = ControlledCodex::new().await;
    let request_id = RequestId::new();

    assert!(matches!(
        fixture
            .reconcile_send(request_id.clone(), None, None)
            .await
            .unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Queued
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 0);
    let journal_rows: i64 = Connection::open(fixture.supervisor.registry.database_path())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![fixture.soul.as_str(), request_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(journal_rows, 0);

    let queued_request_id = RequestId::new();
    fixture
        .supervisor
        .registry
        .begin_input(
            fixture.soul.clone(),
            queued_request_id.clone(),
            b"original public reference input",
            Some(b"null"),
        )
        .await
        .unwrap();
    assert!(matches!(
        fixture
            .reconcile_send(queued_request_id.clone(), None, None)
            .await
            .unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Queued
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 0);
    let queued_state: String = Connection::open(fixture.supervisor.registry.database_path())
        .unwrap()
        .query_row(
            "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
            params![fixture.soul.as_str(), queued_request_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queued_state, "queued");
    fixture.peer.abort();
}

#[tokio::test]
async fn receipt_reconcile_preserves_a_recorded_provider_refusal() {
    let fixture = ControlledCodex::new().await;
    let request_id = RequestId::new();
    let checkpoint_logical_attempt_id = Some("logical-attempt-refused".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation = serde_json::to_vec(&(
        settings.as_ref(),
        checkpoint_logical_attempt_id.as_deref().unwrap(),
    ))
    .unwrap();
    let (disposition, _) = fixture
        .supervisor
        .registry
        .begin_fresh_input(
            fixture.soul.clone(),
            request_id.clone(),
            b"original public reference input",
            &settings_correlation,
            settings.clone(),
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    fixture
        .supervisor
        .registry
        .mark_input_dispatching(fixture.soul.clone(), request_id.clone())
        .await
        .unwrap();
    fixture
        .supervisor
        .registry
        .mark_fresh_input_refused(
            fixture.soul.clone(),
            request_id.clone(),
            freshell_runtime_protocol::FreshAgentSendDiagnostic {
                outcome: freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Refused,
                message: Some("the provider refused the original prompt".into()),
            },
        )
        .await
        .unwrap();

    let error = fixture
        .reconcile_send(request_id, checkpoint_logical_attempt_id, settings)
        .await
        .unwrap_err();
    assert_eq!(
        error
            .fresh_agent_send_diagnostic
            .as_ref()
            .unwrap()
            .message
            .as_deref(),
        Some("the provider refused the original prompt")
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 0);
    fixture.peer.abort();
}

#[tokio::test]
async fn receipt_reconcile_persists_a_proven_refusal_for_an_ambiguous_send() {
    let fixture = ControlledCodex::new().await;
    let request_id = RequestId::new();
    let checkpoint_logical_attempt_id = Some("logical-attempt-receipt-refused".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation = serde_json::to_vec(&(
        settings.as_ref(),
        checkpoint_logical_attempt_id.as_deref().unwrap(),
    ))
    .unwrap();
    let (disposition, _) = fixture
        .supervisor
        .registry
        .begin_fresh_input(
            fixture.soul.clone(),
            request_id.clone(),
            b"original public reference input",
            &settings_correlation,
            settings.clone(),
        )
        .await
        .unwrap();
    assert_eq!(disposition, InputJournalDisposition::Dispatch);
    fixture
        .supervisor
        .registry
        .mark_input_dispatching(fixture.soul.clone(), request_id.clone())
        .await
        .unwrap();
    fixture.receipt_refused.store(true, Ordering::SeqCst);

    let error = fixture
        .reconcile_send(
            request_id.clone(),
            checkpoint_logical_attempt_id.clone(),
            settings.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error
            .fresh_agent_send_diagnostic
            .as_ref()
            .and_then(|diagnostic| diagnostic.message.as_deref()),
        None
    );
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id.clone(),
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Refused(
            error.fresh_agent_send_diagnostic.clone().unwrap()
        ))
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);

    let repeated = fixture
        .reconcile_send(request_id, checkpoint_logical_attempt_id, settings)
        .await
        .unwrap_err();
    assert_eq!(
        repeated.fresh_agent_send_diagnostic,
        error.fresh_agent_send_diagnostic
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    fixture.peer.abort();
}

#[tokio::test]
async fn ordinary_same_root_codex_send_skips_identity_rewrite_after_intent_change() {
    let fixture = ControlledCodex::new().await;
    fixture.exited.store(false, Ordering::SeqCst);
    fixture.readiness_root_change.store(true, Ordering::SeqCst);

    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let mut limits = context.requested_limits;
    limits.cpu_milli += 100;
    fixture
        .supervisor
        .registry
        .update_configured_limits(fixture.soul.clone(), limits, context.intent_revision)
        .await
        .unwrap();

    let sent = fixture.send(RequestId::new()).await;
    assert!(
        matches!(sent, Ok(AdminResult::FreshAgentCommand { state: CommandState::ProviderAcked })),
        "unchanged Codex root should not try to rewrite its writer claim after a harmless intent revision: {sent:?}"
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn configured_limits_change_preserves_current_codex_recovery_source() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let source_before = fixture
        .supervisor
        .registry
        .codex_dispatch_recovery_source(fixture.soul.clone())
        .await
        .unwrap()
        .expect("current Codex writer should have a recovery source");
    assert!(source_before.matches_context(&before));

    let mut limits = before.requested_limits;
    limits.cpu_milli += 100;
    fixture
        .supervisor
        .registry
        .update_configured_limits(fixture.soul.clone(), limits, before.intent_revision)
        .await
        .unwrap();

    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let source_after = fixture
        .supervisor
        .registry
        .codex_dispatch_recovery_source(fixture.soul.clone())
        .await
        .unwrap()
        .expect("a limits-only intent change must preserve the current Codex writer source");
    assert!(source_after.matches_context(&after));
}

#[tokio::test]
async fn manual_retry_prepares_retained_codex_before_marking_it_live() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();

    let result = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .unwrap();

    assert_eq!(result.outcome, RecoveryOutcome::Reattached, "{result:?}");
    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
    assert!(!fixture.exited.load(Ordering::SeqCst));
    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(after.recovery_state, RecoveryState::Live);
    assert_eq!(after.native_session_id, before.native_session_id);
}

#[tokio::test]
async fn manual_retry_classifies_blocked_codex_when_readiness_fails_without_a_pending_receipt() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .supervisor
        .registry
        .mark_recovery_blocked(
            fixture.soul.clone(),
            None,
            freshell_runtime_protocol::RecoveryBlockReason::RetryBudget,
            vec!["automatic retry budget exhausted".into()],
            before.write_fence(),
        )
        .await
        .unwrap();
    let native_prepares_before = fixture.native_prepares.load(Ordering::SeqCst);
    fixture.native_prepare_refuse.store(true, Ordering::SeqCst);

    let result = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .expect("a failed readiness check without a pending receipt must enter normal recovery");

    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(after.intent_revision, before.intent_revision + 1);
    assert!(
        fixture.native_prepares.load(Ordering::SeqCst) > native_prepares_before,
        "manual retry must perform a readiness attempt beyond fixture setup"
    );
    assert_eq!(after.recovery_state, RecoveryState::Live, "{result:?}");
    assert_eq!(result.outcome, RecoveryOutcome::Reattached, "{result:?}");
    assert_eq!(
        fixture.recovery_probes.load(Ordering::SeqCst),
        2,
        "manual readiness preflight and normal recovery each require an exact store read"
    );
}

#[tokio::test]
async fn manual_retry_does_not_advance_intent_when_running_host_receipt_state_is_unavailable() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .supervisor
        .registry
        .mark_recovery_blocked(
            fixture.soul.clone(),
            None,
            freshell_runtime_protocol::RecoveryBlockReason::RetryBudget,
            vec!["automatic retry budget exhausted".into()],
            before.write_fence(),
        )
        .await
        .unwrap();
    let blocked = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.peer.abort();

    let result = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(blocked.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await;
    assert!(
        result.is_err(),
        "a running host with unreadable receipt state must defer Manual Retry"
    );

    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(after.intent_revision, blocked.intent_revision);
    assert_eq!(after.recovery_state, RecoveryState::Blocked);
    let lifecycle = std::fs::read_to_string(&fixture.supervisor.config.lifecycle_log).unwrap();
    assert!(lifecycle.contains("supervisor.manual_retry_readiness_deferred"));
    assert_eq!(fixture.backend.stops.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn receipt_reconcile_clears_a_codex_send_block() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("receipt-blocked-replacement").unwrap();
    let logical_attempt_id = Some("receipt-blocked-replacement-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    let send_error = fixture
        .send_with_checkpoint(
            request_id.clone(),
            logical_attempt_id.clone(),
            settings.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(send_error.code, RuntimeErrorCode::HostUnreachable);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id.clone(),
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Ambiguous)
    );

    let before_block = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.receipt_capability.store(true, Ordering::SeqCst);
    fixture
        .receipt_identity_mismatch
        .store(true, Ordering::SeqCst);
    let blocked = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before_block.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .expect("a live receipt-capable host must hold Manual Retry behind its receipt");
    assert_eq!(blocked.outcome, RecoveryOutcome::Blocked, "{blocked:?}");
    assert!(matches!(
        blocked.probe,
        Some(RecoveryProbe::Blocked {
            reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
            ..
        })
    ));
    let blocked_context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(blocked_context.recovery_state, RecoveryState::Blocked);
    assert_eq!(
        blocked_context.intent_revision,
        before_block.intent_revision
    );

    fixture
        .receipt_identity_mismatch
        .store(false, Ordering::SeqCst);
    let reconciled = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before_block.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .expect("Manual Retry should use the durable request ID to settle the send");
    assert!(!matches!(
        reconciled.probe,
        Some(RecoveryProbe::Blocked {
            reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
            ..
        })
    ));
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 2);
    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert!(after.intent_revision > before_block.intent_revision);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id,
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Completed)
    );
    fixture.peer.abort();
}

#[tokio::test]
async fn reserved_recovery_reconciles_codex_receipt_without_browser_payload() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("reserved-receipt-recovery").unwrap();
    let logical_attempt_id = Some("reserved-receipt-recovery-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    assert_eq!(
        fixture
            .send_with_checkpoint(
                request_id.clone(),
                logical_attempt_id.clone(),
                settings.clone(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::HostUnreachable
    );

    let before_block = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.receipt_capability.store(true, Ordering::SeqCst);
    fixture
        .receipt_identity_mismatch
        .store(true, Ordering::SeqCst);
    let blocked = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before_block.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .unwrap();
    assert!(matches!(
        blocked.probe,
        Some(RecoveryProbe::Blocked {
            reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
            ..
        })
    ));

    fixture
        .receipt_identity_mismatch
        .store(false, Ordering::SeqCst);
    let blocked_context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let reserved = fixture
        .supervisor
        .registry
        .reserve_due_recovery_retry(
            fixture.soul.clone(),
            blocked_context.intent_revision,
            fixture.supervisor.registry.recovery_now_ms(),
        )
        .await
        .unwrap()
        .expect("the simulated scheduled retry reserves an attempt");
    let recovering = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(recovering.recovery_state, RecoveryState::Recovering);
    assert_eq!(recovering.recovery_attempt_id, reserved.reserved_attempt_id);

    let recovered = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: Some(recovering.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .expect("reserved recovery can reconcile its receipt by request ID");
    assert!(!matches!(
        recovered.probe,
        Some(RecoveryProbe::Blocked {
            reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
            ..
        })
    ));
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id,
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Completed)
    );
    fixture.peer.abort();
}

#[tokio::test]
async fn recovery_receipt_refusal_settles_by_id_without_browser_payload() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("refused-recovery-receipt").unwrap();
    let logical_attempt_id = Some("refused-recovery-receipt-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    assert_eq!(
        fixture
            .send_with_checkpoint(request_id.clone(), logical_attempt_id, settings,)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::HostUnreachable
    );

    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.receipt_capability.store(true, Ordering::SeqCst);
    fixture.receipt_refused.store(true, Ordering::SeqCst);
    fixture
        .supervisor
        .reconcile_pending_codex_dispatch_recovery_receipts(&context)
        .await
        .expect("the supervisor can record a typed refusal by durable request ID");

    let outcome = fixture
        .supervisor
        .registry
        .recorded_input_outcome(
            fixture.soul.clone(),
            request_id,
            b"original public reference input",
            Some(&settings_correlation),
        )
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        Some(InputJournalDisposition::Refused(diagnostic))
            if diagnostic.outcome
                == freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Refused
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    fixture.peer.abort();
}

#[tokio::test]
async fn live_codex_receipt_sweep_reconciles_without_a_browser_request() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("browser-free-live-receipt").unwrap();
    let logical_attempt_id = Some("browser-free-live-receipt-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    assert_eq!(
        fixture
            .send_with_checkpoint(request_id.clone(), logical_attempt_id, settings,)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::HostUnreachable
    );
    fixture.receipt_capability.store(true, Ordering::SeqCst);

    fixture
        .supervisor
        .reconcile_live_codex_dispatch_recovery_receipts_once()
        .await
        .expect("the periodic supervisor sweep can recover without browser state");

    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id,
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Completed)
    );
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-child")
    );
    fixture.peer.abort();
}

#[tokio::test]
async fn terminal_ambiguous_receipt_releases_only_the_recovery_hold() {
    use freshell_runtime_protocol::RecoveryBlockReason;

    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("terminal-ambiguous-receipt").unwrap();
    let logical_attempt_id = Some("terminal-ambiguous-receipt-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    assert_eq!(
        fixture
            .send_with_checkpoint(request_id.clone(), logical_attempt_id, settings,)
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::HostUnreachable
    );
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .supervisor
        .registry
        .mark_recovery_blocked(
            fixture.soul.clone(),
            None,
            RecoveryBlockReason::CommandAmbiguous,
            Vec::new(),
            context.write_fence(),
        )
        .await
        .unwrap();
    fixture
        .terminal_ambiguous_receipt
        .store(true, Ordering::SeqCst);
    fixture.receipt_capability.store(true, Ordering::SeqCst);

    fixture
        .supervisor
        .reconcile_pending_codex_dispatch_recovery_receipts(&context)
        .await
        .unwrap();

    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .unresolved_codex_dispatch_recovery_receipt_count(
                fixture.soul.clone(),
                fixture.incarnation.clone(),
            )
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id,
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Ambiguous)
    );
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .recovery_state,
        RecoveryState::Live
    );
    fixture.peer.abort();
}

#[tokio::test]
async fn stale_codex_receipt_hold_expires_without_replaying_the_input() {
    use freshell_runtime_protocol::RecoveryBlockReason;

    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("stale-codex-receipt-hold").unwrap();
    let logical_attempt_id = Some("stale-codex-receipt-hold-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let settings_correlation =
        serde_json::to_vec(&(settings.as_ref(), logical_attempt_id.as_deref().unwrap())).unwrap();
    assert_eq!(
        fixture
            .send_with_checkpoint(
                request_id.clone(),
                logical_attempt_id.clone(),
                settings.clone(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::HostUnreachable
    );
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .supervisor
        .registry
        .mark_recovery_blocked(
            fixture.soul.clone(),
            None,
            RecoveryBlockReason::CommandAmbiguous,
            Vec::new(),
            context.write_fence(),
        )
        .await
        .unwrap();
    rusqlite::Connection::open(fixture.supervisor.registry.database_path())
        .unwrap()
        .execute(
            "UPDATE input_commands SET updated_at=0 WHERE soul_id=?1 AND request_id=?2",
            params![fixture.soul.as_str(), request_id.as_str()],
        )
        .unwrap();

    fixture
        .supervisor
        .reconcile_live_codex_dispatch_recovery_receipts_once()
        .await
        .unwrap();

    assert_eq!(fixture.receipt_queries.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .unresolved_codex_dispatch_recovery_receipt_count(
                fixture.soul.clone(),
                fixture.incarnation.clone(),
            )
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recorded_input_outcome(
                fixture.soul.clone(),
                request_id.clone(),
                b"original public reference input",
                Some(&settings_correlation),
            )
            .await
            .unwrap(),
        Some(InputJournalDisposition::Ambiguous)
    );
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    let replay = fixture
        .send_with_checkpoint(request_id, logical_attempt_id, settings)
        .await
        .unwrap();
    assert!(matches!(
        replay,
        AdminResult::FreshAgentCommand {
            state: CommandState::Ambiguous
        }
    ));
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    fixture.peer.abort();
}

#[tokio::test]
async fn verified_host_loss_does_not_permanently_block_an_unresolved_codex_receipt() {
    let fixture = ControlledCodex::new().await;
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::parse("receipt-host-loss-replacement").unwrap();
    let logical_attempt_id = Some("receipt-host-loss-replacement-attempt".to_string());
    let settings = Some(freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(fixture._root.path().to_string_lossy().into_owned()),
        model: Some("gpt-5-codex".into()),
        ..Default::default()
    });
    let send_error = fixture
        .send_with_checkpoint(request_id.clone(), logical_attempt_id, settings)
        .await
        .unwrap_err();
    assert_eq!(send_error.code, RuntimeErrorCode::HostUnreachable);

    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    fixture.backend.ended.store(true, Ordering::SeqCst);
    fixture.peer.abort();
    let recovery = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await;

    assert!(
        fixture.backend.stops.load(Ordering::SeqCst) > 0
            || fixture.backend.creates.load(Ordering::SeqCst) > 0,
        "after the exact host is confirmed exited, recovery should proceed to cleanup or replacement; result: {recovery:?}"
    );
    if let Ok(result) = recovery {
        assert!(!matches!(
            result.probe,
            Some(RecoveryProbe::Blocked {
                reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
                ..
            })
        ));
    }
    let manual_retry = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await;
    assert_ne!(
        manual_retry
            .ok()
            .and_then(|result| result.probe)
            .and_then(|probe| match probe {
                RecoveryProbe::Blocked { reason, .. } => Some(reason),
                _ => None,
            }),
        Some(freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous),
        "Manual Retry after host loss must use the normal recovery classifier"
    );
}

#[tokio::test]
async fn ordinary_codex_send_ambiguity_does_not_block_verified_recovery() {
    let fixture = ControlledCodex::new().await;
    fixture.exited.store(false, Ordering::SeqCst);
    fixture.receipt_capability.store(false, Ordering::SeqCst);
    fixture.lose_send_reply_once.store(true, Ordering::SeqCst);
    let request_id = RequestId::new();
    let send_error = fixture.send(request_id).await.unwrap_err();
    assert_eq!(send_error.code, RuntimeErrorCode::HostUnreachable);

    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(
        fixture
            .supervisor
            .registry
            .unresolved_codex_dispatch_recovery_receipt_count(
                fixture.soul.clone(),
                before.prior_handle.incarnation_id().clone(),
            )
            .await
            .unwrap(),
        0,
        "ordinary live Codex sends do not carry a host receipt source"
    );

    fixture.backend.ended.store(true, Ordering::SeqCst);
    fixture.peer.abort();
    let recovery = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ProviderExit,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await;
    assert!(
        fixture.backend.stops.load(Ordering::SeqCst) > 0
            || fixture.backend.creates.load(Ordering::SeqCst) > 0,
        "receipt-less history must not block standard recovery; result: {recovery:?}"
    );
    if let Ok(result) = recovery {
        assert!(!matches!(
            result.probe,
            Some(RecoveryProbe::Blocked {
                reason: freshell_runtime_protocol::RecoveryBlockReason::CommandAmbiguous,
                ..
            })
        ));
    }
}

#[tokio::test]
async fn manual_retry_reconciles_pending_readiness_receipt_before_rearming() {
    let fixture = ControlledCodex::new().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let source_launch = before.native_identity_launch.clone().unwrap();
    let mut next_launch = source_launch.clone();
    next_launch.evidence_revision += 1;
    next_launch.requested_native_session_id = Some("native-readiness-child".into());
    let receipt = NativeReadinessReceipt {
        source_fence: before.write_fence().native_readiness_fence(),
        source_launch: source_launch.clone(),
        next_launch: next_launch.clone(),
        identity: NativeDispatchIdentity {
            previous_native_session_id: "native-parent".into(),
            native_session_id: "native-readiness-child".into(),
            pending_naming_handle: None,
        },
        absence_evidence: None,
        resume_spec_sha256: None,
    };
    assert!(receipt.is_valid());
    {
        let mut source = fixture.source.lock().unwrap();
        source.native_session_id = "native-readiness-child".into();
        source.evidence_revision = next_launch.evidence_revision;
    }
    fixture.exited.store(false, Ordering::SeqCst);
    *fixture.readiness_receipt.lock().unwrap() = Some(receipt.clone());
    fixture.native_prepare_refuse.store(true, Ordering::SeqCst);

    let result = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(before.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .unwrap();

    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Reattached, "{result:?}");
    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 2);
    assert_eq!(
        after.native_session_id.as_deref(),
        Some("native-readiness-child")
    );
    assert_eq!(
        after.native_identity_launch.as_ref(),
        Some(&next_launch),
        "the receipt's provider launch is committed before ManualRetry changes intent"
    );
    assert_eq!(after.intent_revision, before.intent_revision + 1);
    assert_eq!(
        fixture.readiness_receipt.lock().unwrap().as_ref(),
        Some(&receipt),
        "the host keeps the committed receipt in durable status"
    );

    // A later failed readiness probe sees the same durable receipt after it
    // has already been committed. Presence alone must not make ManualRetry
    // try to commit it under the stale source fence.
    fixture.native_prepare_refuse.store(true, Ordering::SeqCst);
    let next = fixture
        .supervisor
        .recover(RecoverRequest {
            soul_id: fixture.soul.clone(),
            trigger: RecoveryTrigger::ManualRetry,
            expected_intent_revision: Some(after.intent_revision),
            expected_control_epoch: Some(fixture.supervisor.registry.control_epoch()),
        })
        .await
        .expect("a previously committed persistent receipt is not pending work");
    let final_state = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(next.outcome, RecoveryOutcome::Reattached, "{next:?}");
    assert_eq!(final_state.intent_revision, after.intent_revision + 1);
    assert_eq!(
        final_state.native_session_id.as_deref(),
        Some("native-readiness-child")
    );
    assert_eq!(
        fixture.readiness_receipt.lock().unwrap().as_ref(),
        Some(&receipt)
    );
}

#[tokio::test]
async fn public_send_refuses_uncommitted_child_after_native_exit() {
    let fixture = ControlledCodex::new().await;
    {
        let mut source = fixture.source.lock().unwrap();
        source.native_session_id = "uncommitted-child".into();
        source.evidence_revision = 8;
    }
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
}

#[tokio::test]
async fn observer_does_not_spend_attempt_while_native_ack_is_in_flight() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture.hold_ack.store(true, Ordering::SeqCst);
    let send = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.send(RequestId::new()).await })
    };
    fixture.sending.notified().await;
    let mut observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    tokio::select! {
        result=&mut observer=>{result.unwrap().unwrap();},
        _=fixture.transient_status.notified()=>{fixture.release.notify_one();(&mut observer).await.unwrap().unwrap();}
    }
    fixture.release.notify_one();
    send.await.unwrap().unwrap();
    fixture.hold_ack.store(false, Ordering::SeqCst);
    fixture.assert_retained().await;
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
}

#[tokio::test]
async fn public_compact_rechecks_writer_and_generation_after_held_readiness() {
    for case in [
        "writer",
        "generation",
        "source",
        "nonce",
        "revision",
        "host-boot",
        "intent",
        "stopped",
        "same-root-capability",
        "future-control-epoch",
    ] {
        let fixture = Arc::new(ControlledCodex::new().await);
        fixture.hold_ack.store(true, Ordering::SeqCst);
        let compact = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.compact().await })
        };
        fixture.sending.notified().await;
        let observer = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.supervisor.observe_once().await })
        };
        tokio::time::timeout(Duration::from_secs(2), fixture.status_observed.notified())
            .await
            .expect("observer should snapshot host status while Compact owns the lifecycle lock");
        assert!(
            !observer.is_finished(),
            "observer should wait for the lifecycle lock instead of dropping its observation"
        );
        fixture.assert_retained().await;
        let conn = Connection::open(fixture.supervisor.registry.database_path()).unwrap();
        match case {
            "writer" => {
                conn.execute("DELETE FROM writer_claims", []).unwrap();
            }
            "generation" => {
                conn.execute("UPDATE incarnations SET execution_generation=2", [])
                    .unwrap();
            }
            "source" => fixture.source.lock().unwrap().native_session_id = "foreign-root".into(),
            "nonce" => fixture.source.lock().unwrap().launch_nonce = "foreign-nonce".into(),
            "revision" => fixture.source.lock().unwrap().evidence_revision += 1,
            "host-boot" => {
                conn.execute(
                    "UPDATE incarnations SET host_boot_id=?1",
                    [HostBootId::new().as_str()],
                )
                .unwrap();
            }
            "intent" => {
                conn.execute("UPDATE souls SET intent_revision=intent_revision+1", [])
                    .unwrap();
            }
            "stopped" => {
                conn.execute("UPDATE souls SET desired_state='stopped'", [])
                    .unwrap();
            }
            "same-root-capability" => fixture.same_root_capability.store(false, Ordering::SeqCst),
            "future-control-epoch" => fixture.host_epoch.store(
                fixture.supervisor.registry.control_epoch() + 1,
                Ordering::SeqCst,
            ),
            _ => unreachable!(),
        }
        fixture.release.notify_one();
        assert!(
            compact.await.unwrap().is_err(),
            "changed {case} must refuse before strict Compact"
        );
        observer.await.unwrap().unwrap();
        assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.compacts.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.attempts(), 0);
    }
}

#[tokio::test]
async fn public_compact_refusal_preserves_later_explicit_send_recovery() {
    let fixture = ControlledCodex::new().await;
    fixture.prepare_refuse.store(true, Ordering::SeqCst);
    assert!(fixture.compact().await.is_err());
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    fixture.send(RequestId::new()).await.unwrap();
    fixture.send(RequestId::new()).await.unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-child")
    );
    fixture.assert_retained().await;
}

#[tokio::test]
async fn observer_during_compact_readiness_and_compact_does_not_spend_attempt() {
    for preparing in [false, true] {
        let fixture = Arc::new(ControlledCodex::new().await);
        fixture.exited.store(preparing, Ordering::SeqCst);
        fixture.hold_ack.store(true, Ordering::SeqCst);
        let operation = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.compact().await })
        };
        fixture.sending.notified().await;
        fixture.status_busy.store(preparing, Ordering::SeqCst);
        let statuses_before_observer = fixture.statuses.load(Ordering::SeqCst);
        let observer = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.supervisor.observe_once().await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while fixture.statuses.load(Ordering::SeqCst) <= statuses_before_observer {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("observer must take its own host Status snapshot while Compact is held");
        assert!(
            !observer.is_finished(),
            "observer should wait for the lifecycle lock instead of dropping its observation"
        );
        fixture.assert_retained().await;
        fixture.hold_ack.store(false, Ordering::SeqCst);
        fixture.release.notify_one();
        operation.await.unwrap().unwrap();
        observer.await.unwrap().unwrap();
        fixture.assert_retained().await;
        assert_eq!(
            fixture.attempts(),
            0,
            "a status captured during Codex same-root preparation must not schedule recovery after Compact succeeds"
        );
        fixture.peer.abort();
        fixture.backend.ended.store(true, Ordering::SeqCst);
        fixture.supervisor.observe_once().await.unwrap();
        assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.attempts(), 1);
    }
}

#[tokio::test]
async fn public_send_recovery_keeps_owner_source_and_control_fences() {
    for case in [
        "nonce",
        "revision",
        "incarnation",
        "source",
        "missing-source",
        "worker",
        "capability",
        "writer",
        "foreign-writer-incarnation",
        "foreign-writer-soul",
        "stale-writer-intent",
        "host-boot",
        "generation",
        "db-generation",
        "stopped",
        "provider",
        "fixture",
    ] {
        let fixture = ControlledCodex::new().await;
        let conn = Connection::open(fixture.supervisor.registry.database_path()).unwrap();
        match case {
            "nonce" => fixture.source.lock().unwrap().launch_nonce = "old-launch".into(),
            "revision" => fixture.source.lock().unwrap().evidence_revision += 1,
            "incarnation" => fixture.source.lock().unwrap().incarnation_id = IncarnationId::new(),
            "source" => {
                fixture.source.lock().unwrap().source = NativeIdentitySource::CodexAppServer
            }
            "missing-source" => {
                fixture.hold_ack.store(true, Ordering::SeqCst);
                fixture.inputs.store(1, Ordering::SeqCst);
            }
            "worker" => fixture.worker.store(false, Ordering::SeqCst),
            "capability" => fixture.capability.store(false, Ordering::SeqCst),
            "writer" => {
                conn.execute(
                    "DELETE FROM writer_claims WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "foreign-writer-incarnation" | "foreign-writer-soul" => {
                let foreign_soul = SoulId::new();
                let foreign = crate::registry::tests::materialize_fresh_runtime(
                    &fixture.supervisor.registry,
                    foreign_soul.clone(),
                    fixture._root.path(),
                )
                .await;
                if case == "foreign-writer-incarnation" {
                    conn.execute(
                        "UPDATE writer_claims SET incarnation_id=?1 WHERE soul_id=?2",
                        params![foreign.incarnation_id.as_str(), fixture.soul.as_str()],
                    )
                    .unwrap();
                } else {
                    conn.execute(
                        "UPDATE writer_claims SET soul_id=?1 WHERE soul_id=?2",
                        params![foreign_soul.as_str(), fixture.soul.as_str()],
                    )
                    .unwrap();
                }
            }
            "stale-writer-intent" => {
                conn.execute(
                    "UPDATE writer_claims SET intent_revision=intent_revision+1 WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "host-boot" => {
                conn.execute(
                    "UPDATE incarnations SET host_boot_id=?1 WHERE incarnation_id=?2",
                    params![HostBootId::new().as_str(), fixture.incarnation.as_str()],
                )
                .unwrap();
            }
            "generation" => {
                let mut context = fixture
                    .supervisor
                    .registry
                    .recovery_context(fixture.soul.clone())
                    .await
                    .unwrap()
                    .native_identity_launch
                    .unwrap();
                context.execution_generation += 1;
                conn.execute(
                    "UPDATE incarnations SET native_identity_launch=?1 WHERE incarnation_id=?2",
                    params![
                        serde_json::to_string(&context).unwrap(),
                        fixture.incarnation.as_str()
                    ],
                )
                .unwrap();
            }
            "db-generation" => {
                conn.execute(
                    "UPDATE incarnations SET execution_generation=2 WHERE incarnation_id=?1",
                    [fixture.incarnation.as_str()],
                )
                .unwrap();
            }
            "stopped" => {
                fixture
                    .supervisor
                    .registry
                    .begin_stop(fixture.soul.clone())
                    .await
                    .unwrap();
            }
            "provider" => {
                conn.execute(
                    "UPDATE souls SET provider='claude' WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "fixture" => {
                let mut context = fixture
                    .supervisor
                    .registry
                    .recovery_context(fixture.soul.clone())
                    .await
                    .unwrap()
                    .fresh_agent
                    .unwrap();
                context.fixture_transport =
                    Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic);
                conn.execute(
                    "UPDATE incarnations SET fresh_agent_spec=?1 WHERE incarnation_id=?2",
                    params![
                        serde_json::to_string(&context).unwrap(),
                        fixture.incarnation.as_str()
                    ],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let before = fixture.inputs.load(Ordering::SeqCst);
        let send_error = fixture.send(RequestId::new()).await.unwrap_err();
        if case == "provider" {
            assert_eq!(send_error.code, RuntimeErrorCode::OwnershipMismatch);
        }
        assert!(fixture.compact().await.is_err(), "{case} Compact");
        assert_eq!(
            fixture.prepares.load(Ordering::SeqCst),
            0,
            "{case} never prepares"
        );
        assert_eq!(
            fixture.compacts.load(Ordering::SeqCst),
            0,
            "{case} never compacts"
        );
        assert_eq!(
            fixture.inputs.load(Ordering::SeqCst),
            before,
            "{case} never dispatches"
        );
    }
}

#[tokio::test]
async fn retained_codex_recovery_does_not_admit_native_controls() {
    let fixture = ControlledCodex::new().await;
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(context.provider, "codex");
    assert!(context.fixture.is_none());
    assert_eq!(
        context.desired_state,
        freshell_runtime_protocol::DesiredState::Running
    );
    assert_eq!(context.native_session_id.as_deref(), Some("native-parent"));
    let launch = context.native_identity_launch.as_ref().unwrap();
    assert!(
        launch.evidence_revision < context.evidence_revision,
        "captured resume evidence must advance the durable fence without rewriting native launch proof"
    );
    assert_eq!(
        launch.incarnation_id,
        *context.prior_handle.incarnation_id()
    );
    assert_eq!(
        launch.launch_nonce,
        context.prior_handle.launch_nonce().as_str()
    );
    assert_eq!(launch.execution_generation, 1);
    assert!(!context.never_dispatched);
    let native_observation = fixture
        .supervisor
        .registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|view| view.soul_id == fixture.soul)
        .and_then(|view| view.native_identity_observation)
        .expect("retained Codex fixture must have exact native identity evidence");
    assert_eq!(
        launch.evidence_revision,
        native_observation.evidence_revision
    );
    assert_eq!(launch.incarnation_id, native_observation.incarnation_id);
    assert_eq!(
        launch.requested_native_session_id.as_deref(),
        Some("native-parent")
    );
    assert_eq!(
        context
            .fresh_agent
            .as_ref()
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
    assert!(!crate::registry::deterministic_fresh_agent_fixture(
        &context.provider,
        context.fresh_agent.as_ref().unwrap()
    ));
    assert!(
        crate::resume_catalog::exact_resume_candidate(&context, None)
            .unwrap()
            .is_some()
    );
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
    assert!(host
        .capabilities
        .iter()
        .any(|capability| capability == HOST_CAPABILITY_NATIVE_READINESS_RECEIPT_V1));
    let status = fixture
        .supervisor
        .host_status(active.incarnation_id().clone(), active.runtime_dir(), &host)
        .await
        .unwrap();
    assert!(status.exited);
    assert_eq!(status.max_execution_generation, 1);
    assert!(
        fixture
            .supervisor
            .retained_codex_host_eligible(&context, &host, &status)
            .await
            .unwrap(),
        "the coherent exact Codex source remains eligible for SEND recovery"
    );
    let prepare_error = fixture
        .supervisor
        .fresh_agent_prepare_native(fixture.soul.clone())
        .await
        .unwrap_err();
    assert_eq!(prepare_error.code, RuntimeErrorCode::RecoveryBlocked);
    assert!(prepare_error
        .message
        .contains("fresh-agent input requires the current committed native identity"));
    let error = fixture
        .supervisor
        .fresh_agent_resolve(
            fixture.soul.clone(),
            "unobserved-control".into(),
            serde_json::json!({"behavior":"allow"}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);
    assert_eq!(
        fixture.recovery_probes.load(Ordering::SeqCst),
        0,
        "neither native preparation nor permission resolution may probe/restart the old host"
    );
    assert_eq!(fixture.native_prepares.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.resolves.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
}

#[tokio::test]
async fn bad_native_ack_is_ambiguous_and_cannot_replay_or_admit_uncommitted_source() {
    let fixture = ControlledCodex::new().await;
    fixture.bad_ack.store(true, Ordering::SeqCst);
    let request = RequestId::new();
    assert_eq!(
        fixture.send(request.clone()).await.unwrap_err().code,
        RuntimeErrorCode::OwnershipMismatch
    );
    assert!(matches!(
        fixture.send(request).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Ambiguous
        }
    ));
    fixture.exited.store(true, Ordering::SeqCst);
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
}
