//! Claude-purpose source authority. No lifecycle lock is reacquired by the
//! nested recovery callback, and no registry/map lock crosses helper IPC.
use super::*;
use crate::backend::ClaudeSourceOwner;
use freshell_runtime_protocol::{ClaudeSourceAuthority, ObserveClaudeSourcesRequest};

impl Supervisor {
    pub(super) async fn observe_claude_sources(
        &self,
        request: ObserveClaudeSourcesRequest,
    ) -> Result<freshell_platform::claude_inputs::observation::ObservationReply, RuntimeError> {
        request.validate()?;
        let denied = || {
            RuntimeError::new(RuntimeErrorCode::InvalidRequest,
            "Claude source observation requires its current creation or recovery attempt; retain inputs and reprepare")
        };
        let unavailable = || {
            RuntimeError::new(RuntimeErrorCode::HostUnreachable,
            "Claude native source evidence is unavailable; retain inputs and repair the source before dispatch")
        };
        let mut recovery = None;
        let owner = match &request.authority {
            ClaudeSourceAuthority::InitialReservation { reservation_id } => {
                let (reservation, expected) = self
                    .registry
                    .initial_input_reservation(request.soul_id.clone(), reservation_id.clone())
                    .await
                    .map_err(map_registry)?
                    .ok_or_else(denied)?;
                if reservation.provider != request.provider
                    || reservation.image_ref != self.config.image_ref
                    || reservation.binary != self.config.host_binary_path
                {
                    return Err(denied());
                }
                let observation = tokio::time::timeout(
                    Duration::from_secs(10),
                    self.backend.observe_initial_auth_volume(&reservation),
                )
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
                if observation != expected {
                    return Err(denied());
                }
                ClaudeSourceOwner::Initial {
                    reservation,
                    observation,
                }
            }
            ClaudeSourceAuthority::RecoveryAttempt { attempt_id } => {
                // This scope already belongs to the callback owner. Eligibility
                // here is Claude/Kilroy, independently of OpenCode auth lookup.
                let authority = {
                    let authorities = self
                        .auth_lookup_authorities
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    authorities
                        .get(attempt_id)
                        .filter(|authority| authority.expires > Instant::now())
                        .cloned()
                        .ok_or_else(denied)?
                };
                if authority.start.context.soul_id != request.soul_id
                    || authority.start.context.provider != request.provider
                    || authority.start.context.prior_handle.image_ref() != self.config.image_ref
                    || authority.start.context.prior_handle.host_binary_path()
                        != self.config.host_binary_path
                    || !self
                        .registry
                        .validate_auth_lookup_attempt(authority.start.clone())
                        .await
                        .map_err(map_registry)?
                {
                    return Err(denied());
                }
                let handle = authority.start.context.prior_handle.clone();
                let recovery_source = if request.candidate.is_some() {
                    let context = handle
                        .terminal()
                        .and_then(|spec| spec.provider_launch_context.as_ref())
                        .or_else(|| {
                            handle
                                .fresh_agent()
                                .and_then(|spec| spec.provider_launch_context.as_ref())
                        })
                        .ok_or_else(denied)?;
                    Some(self.claude_recovery_source_binding(
                        &authority.start,
                        attempt_id,
                        context,
                    )?)
                } else {
                    None
                };
                recovery = Some(authority.start);
                ClaudeSourceOwner::Retained {
                    handle,
                    recovery_source,
                }
            }
        };
        let raw = freshell_runtime_protocol::bounded_json_bytes(
            &request.observation_request,
            freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES,
        )
        .map_err(|_| denied())?;
        let digest = format!("{:x}", Sha256::digest(&raw));
        // The backend owns a 25-second operation and five-second finite cleanup.
        // This outer deadline permits that cleanup to finish before returning.
        let reply = tokio::time::timeout(
            Duration::from_secs(35),
            self.backend
                .observe_claude_sources(&owner, &request, &self.config.test_run_id),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
        reply
            .validate_for_request(&request.observation_request, &digest)
            .map_err(|_| unavailable())?;
        let observed = &reply.observation;
        if (observed.uid, observed.euid, observed.gid, observed.egid) != (65534, 65534, 0, 0) {
            return Err(unavailable());
        }
        match &request.authority {
            ClaudeSourceAuthority::InitialReservation { reservation_id } => {
                let current = self
                    .registry
                    .initial_input_reservation(request.soul_id.clone(), reservation_id.clone())
                    .await
                    .map_err(map_registry)?
                    .ok_or_else(denied)?;
                let ClaudeSourceOwner::Initial {
                    reservation,
                    observation,
                } = &owner
                else {
                    return Err(denied());
                };
                if current.0.binary_sha256 != reservation.binary_sha256 || &current.1 != observation
                {
                    return Err(denied());
                }
            }
            ClaudeSourceAuthority::RecoveryAttempt { attempt_id } => {
                let start = recovery.ok_or_else(denied)?;
                let live_scope = {
                    let authorities = self
                        .auth_lookup_authorities
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    authorities.get(attempt_id).is_some_and(|authority| {
                        authority.expires > Instant::now()
                            && authority.start.attempt_id == start.attempt_id
                            && authority.start.context.soul_id == request.soul_id
                    })
                };
                if !live_scope
                    || !self
                        .registry
                        .validate_auth_lookup_attempt(start)
                        .await
                        .map_err(map_registry)?
                {
                    return Err(denied());
                }
            }
        }
        tracing::debug!(event="provider.inputs.native_source_observation.settled",provider=%request.provider,
            soul_id=%request.soul_id,plan_revision=request.observation_request.plan_revision,
            local_sources=observed.local_settings.len(),uid=observed.uid,gid=observed.gid,
            "Qualified Claude native source observation settled");
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::*;
    use crate::registry::*;
    use async_trait::async_trait;
    use freshell_platform::claude_inputs::observation::{
        LocalDecision, NativeObservation, ObservationReply,
    };
    use freshell_runtime_protocol::*;

    struct ReplyBackend(
        StdMutex<Option<Box<dyn FnOnce() + Send>>>,
        StdMutex<Option<ClaudeRecoverySourceBinding>>,
        std::sync::atomic::AtomicUsize,
    );
    #[async_trait]
    impl RuntimeBackend for ReplyBackend {
        async fn observe_claude_sources(
            &self,
            owner: &ClaudeSourceOwner,
            request: &ObserveClaudeSourcesRequest,
            _: &str,
        ) -> Result<ObservationReply, BackendError> {
            self.2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let ClaudeSourceOwner::Retained {
                handle,
                recovery_source,
            } = owner
            else {
                panic!("requires retained fixture owner");
            };
            assert_eq!(handle.soul_id(), &request.soul_id);
            if let Some(expected) = self.1.lock().unwrap().as_ref() {
                let supplied = recovery_source.as_ref().ok_or_else(|| {
                    BackendError::Unavailable("current registry source provenance missing".into())
                })?;
                if supplied.provider != expected.provider
                    || supplied.registry_attempt_id != expected.registry_attempt_id
                    || supplied.intent_revision != expected.intent_revision
                    || supplied.prior_generation_id != expected.prior_generation_id
                    || supplied.authority_sha256 != expected.authority_sha256
                    || supplied.git_common_dir != expected.git_common_dir
                {
                    return Err(BackendError::Unavailable(
                        "current registry source provenance changed".into(),
                    ));
                }
            }
            let action = self.0.lock().unwrap().take();
            if let Some(action) = action {
                action();
            }
            // This is a synthetic transport reply, never native UID evidence.
            let selected = &request.observation_request;
            let raw = bounded_json_bytes(
                selected,
                freshell_platform::claude_inputs::observation::MAX_REQUEST_BYTES,
            )
            .unwrap();
            Ok(ObservationReply {
                request_sha256: format!("{:x}", Sha256::digest(raw)),
                observation: NativeObservation {
                    version: 1,
                    native_source_runtime: selected.native_source_runtime,
                    setting_sources: selected.setting_sources.clone(),
                    uid: 65534,
                    euid: 65534,
                    gid: 0,
                    egid: 0,
                    supplementary_groups: vec![],
                    cwd: selected.cwd.clone(),
                    home: Some(selected.home.clone()),
                    roots: None,
                    local_decision: LocalDecision::NoRoot,
                    root_uid: None,
                    git_uid: None,
                    claude_uid: None,
                    local_settings: vec![selected.cwd.join(".claude/settings.local.json")],
                },
            })
        }
        async fn create_stopped(
            &self,
            _: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            unreachable!()
        }
        async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
            unreachable!()
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            unreachable!()
        }
        async fn list_known(
            &self,
            _: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            unreachable!()
        }
        async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
            unreachable!()
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn provider_claude_nested_source_reply_requires_live_scope_after_private_ipc() {
        for mode in [
            "live",
            "dropped",
            "expired",
            "candidate",
            "candidate-dropped",
            "candidate-expired",
            "candidate-unrecorded-prior",
        ] {
            let owned = tempfile::tempdir().unwrap();
            let binary = owned.path().join("host");
            std::fs::write(&binary, b"synthetic helper artifact").unwrap();
            let prior = owned.path().join("accepted-prior-inputs");
            std::fs::write(&prior, b"immutable accepted prior generation").unwrap();
            let registry = Registry::open(owned.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let limits = RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            };
            let prior_generation = format!("grant-{}", uuid::Uuid::new_v4());
            let prior_context:ProviderLaunchContext = serde_json::from_value(serde_json::json!({
                "preparation":{"claude":{"mcp_args":[]}},"config":[],
                "mcpCapability":{"grantId":prior_generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":prior_generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":"a".repeat(64),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
            })).unwrap();
            let terminal = (mode.starts_with("candidate")).then(||serde_json::from_value::<TerminalLaunchSpec>(serde_json::json!({
                "terminalId":"source-provenance","streamId":"source-stream","mode":"claude","program":"claude","args":[],"cwd":owned.path(),"workspacePath":owned.path(),"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"synthetic-workspace","providerLaunchContext":if mode=="candidate-unrecorded-prior" {None} else {Some(&prior_context)}
            })).unwrap());
            let prepared = registry
                .prepare_launch(LaunchPreparation {
                    soul_id: soul.clone(),
                    provider: "claude".into(),
                    provider_store_id: "synthetic-store".into(),
                    native_session_id: None,
                    creation_seed_ref: "synthetic-seed".into(),
                    request_id: RequestId::new(),
                    payload_digest: "synthetic-digest".into(),
                    requested_limits: limits,
                    profile: RuntimeProfile::Custom,
                    project_key: "synthetic-workspace".into(),
                    fixture: None,
                    terminal,
                    fresh_agent: None,
                    view_intent: None,
                    admission: crate::admission::AdmissionPolicy::default(),
                })
                .await
                .unwrap();
            let image = format!("sha256:{}", "a".repeat(64));
            registry
                .commit_created(
                    prepared.incarnation_id,
                    BackendCreatedRecord {
                        daemon_id: DockerDaemonId::new(),
                        container_id: "owned-source-provider-never-stopped".into(),
                        image_ref: image.clone(),
                        runtime_dir: owned.path().into(),
                        host_binary_path: binary.clone(),
                        immutable_config_digest: "synthetic-digest".into(),
                    },
                )
                .await
                .unwrap();
            let start = registry
                .begin_recovery(
                    soul.clone(),
                    RecoveryTrigger::ManualRetry,
                    RecoveryPath::NativeResume,
                )
                .await
                .unwrap();
            let backend = Arc::new(ReplyBackend(
                StdMutex::new(None),
                StdMutex::new(None),
                std::sync::atomic::AtomicUsize::new(0),
            ));
            let supervisor = Supervisor::new(
                registry,
                backend.clone(),
                SupervisorConfig {
                    runtime_root: owned.path().join("runtime"),
                    control_socket_path: owned.path().join("control.sock"),
                    host_binary_path: binary,
                    image_ref: image,
                    test_run_id: "claude-source-scope".into(),
                    control_secret: "synthetic-control-secret".into(),
                    lifecycle_log: owned.path().join("lifecycle.jsonl"),
                    admission: crate::admission::AdmissionPolicy::default(),
                },
            )
            .unwrap();
            let lock = supervisor.lifecycle_lock(&soul).await;
            let _held = lock.lock().await;
            let scope = supervisor.auth_lookup_scope(&start);
            if matches!(
                mode,
                "dropped" | "expired" | "candidate-dropped" | "candidate-expired"
            ) {
                let authorities = supervisor.auth_lookup_authorities.clone();
                let key = scope.key.clone();
                *backend.0.lock().unwrap() = Some(Box::new(move || {
                    let mut map = authorities.lock().unwrap();
                    if mode.ends_with("dropped") {
                        map.remove(&key);
                    } else {
                        map.get_mut(&key).unwrap().expires = Instant::now();
                    }
                }));
            }
            let mut request: ObserveClaudeSourcesRequest=serde_json::from_value(serde_json::json!({
                "expectedControlEpoch":supervisor.registry.control_epoch(),"soulId":soul,"provider":"claude",
                "authority":{"kind":"recovery_attempt","attemptId":scope.key},
                "workspacePath":owned.path(),"gitCommonDir":null,"candidate":null,
                "observationRequest":{"version":1,"requestId":uuid::Uuid::new_v4().to_string(),"nativeSourceRuntime":"sdk",
                    "cwd":owned.path(),"home":"/home/freshell/provider","settingSources":["local"],
                    "selectorManifestSha256":"b".repeat(64),"planRevision":0}
            })).unwrap();
            if mode.starts_with("candidate") {
                let source_binding = ClaudeRecoverySourceBinding {
                    provider: "claude".into(),
                    git_common_dir: None,
                    authority_sha256: format!(
                        "{:x}",
                        Sha256::digest(
                            bounded_json_bytes(&request.authority, MAX_CONTROL_FRAME_BYTES)
                                .unwrap()
                        )
                    ),
                    registry_attempt_id: start.attempt_id.clone(),
                    intent_revision: start.context.intent_revision,
                    prior_generation_id: prior_generation,
                };
                let mut candidate = prior_context.clone();
                let generation = format!("grant-{}", uuid::Uuid::new_v4());
                candidate.mcp_capability.as_mut().unwrap().grant_id = generation.clone();
                candidate.prepared_inputs.as_mut().unwrap().generation_id = generation.clone();
                request.candidate = Some(PreparedProviderContext {
                    provider_launch_context: candidate,
                    provider_secret_references: vec![],
                });
                request.observation_request.candidate_binding = Some(
                    freshell_platform::claude_inputs::observation::CandidateBinding {
                        soul_id: soul.as_str().into(),
                        generation_id: generation,
                        authority_sha256: source_binding.authority_sha256.clone(),
                        publication_sha256: "c".repeat(64),
                        manifest_sha256: "a".repeat(64),
                        prepared_result_sha256: "d".repeat(64),
                    },
                );
                *backend.1.lock().unwrap() = Some(source_binding);
            }
            let mut envelope = Envelope::new(
                RequestId::new(),
                ControlRole::Web,
                AdminCommand::ObserveClaudeSources(request),
            );
            envelope.auth = Some("synthetic-control-secret".into());
            let result = tokio::time::timeout(
                Duration::from_millis(250),
                supervisor.dispatch(envelope),
            )
            .await
            .expect("nested Claude source lookup must not reacquire the held soul lifecycle lock")
            .result;
            assert_eq!(backend.2.load(std::sync::atomic::Ordering::SeqCst),usize::from(mode!="candidate-unrecorded-prior"),"unrecorded prior inputs must block before the backend; valid provenance reaches it once");
            assert_eq!(
                result.is_ok(),
                matches!(mode,"live"|"candidate"),
                "{mode}: changed scoped authority after IPC cannot qualify source evidence: {result:?}"
            );
            if let Err(error) = result {
                assert_eq!(error.code, RuntimeErrorCode::InvalidRequest);
            }
            assert!(std::fs::read(&prior).unwrap() == b"immutable accepted prior generation");
        }
    }
}
