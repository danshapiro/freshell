//! Owning service/recovery tests. Synthetic daemon and authenticated host IPC
//! retain exact generation ownership across real registry/supervisor reopen.
use super::*;
use crate::backend::*;
use crate::registry::OwnedRuntimeHandle;
use async_trait::async_trait;
use freshell_runtime_protocol::*;
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex,
};
use tokio::net::UnixListener;

#[derive(Default)]
struct Daemon {
    generations: BTreeSet<String>,
    publishers: std::collections::BTreeMap<String, IncarnationId>,
    running: BTreeSet<IncarnationId>,
    events: Vec<String>,
    fail: Option<&'static str>,
    grants: usize,
    host_tasks: Vec<tokio::task::JoinHandle<()>>,
    reject_inputs: bool,
    consumed_rejection: bool,
    recovery_probes: Vec<String>,
    recovery_probe_available: bool,
    recovery_probe_gate: Option<Arc<RecoveryProbeGate>>,
    seeded_host: Option<(HostBootId, NativeIdentityLaunch)>,
    unsettled_replacement_gate: Option<Arc<RecoveryProbeGate>>,
    cleanup_failures: usize,
    cleanup_owners: Vec<IncarnationId>,
    termination_unavailable: bool,
    real_workloads: bool,
    workers: std::collections::BTreeMap<IncarnationId, OwnedProviderWorker>,
    completion_gate: Option<Arc<RecoveryProbeGate>>,
    retirement_gate: Option<Arc<RecoveryProbeGate>>,
}

struct OwnedProviderWorker(std::process::Child);
impl Drop for OwnedProviderWorker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[derive(Default)]
struct RecoveryProbeGate {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
struct Backend(Arc<Mutex<Daemon>>, std::path::PathBuf);

fn generation(handle: &OwnedRuntimeHandle) -> String {
    handle
        .terminal()
        .unwrap()
        .provider_launch_context
        .as_ref()
        .unwrap()
        .prepared_inputs
        .as_ref()
        .unwrap()
        .generation_id
        .clone()
}

fn context(soul: &SoulId, ordinal: usize) -> ProviderLaunchContext {
    let generation_id = format!("grant-{ordinal}");
    ProviderLaunchContext {
        preparation: ProviderPreparation::Opencode {
            project_config: vec![],
            tui_config: None,
            tui_source: None,
            inline_config: false,
        },
        config: vec![],
        mcp_capability: Some(McpCapabilityReference {
            grant_id: generation_id.clone(),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        }),
        prepared_inputs: Some(PreparedProviderInputs {
            generation_id: generation_id.clone(),
            initial_auth_reservation: None,
            manifest: ProviderInputManifestReference {
                relative_path: ".freshell/input-manifest.json".into(),
                sha256: "a".repeat(64),
                source_count: 1,
                alias_count: 1,
                recipe_count: 0,
            },
            config_binds: vec![],
            resource_mounts: vec![],
            indexed_files: Some(IndexedProviderFiles {
                volume_name: indexed_provider_volume_name(soul, &generation_id),
                aliases: vec![IndexedProviderFileAlias {
                    source_id: 0,
                    logical_destination: "/home/freshell/provider/.freshell/references/0".into(),
                    effective_destination: "/home/freshell/provider/.freshell/references/0".into(),
                }],
                staged_source_paths: None,
            }),
        }),
    }
}

fn references() -> Vec<ProviderSecretReference> {
    vec![ProviderSecretReference {
        profile: ProviderSecretProfile::OpencodeConfigurationFile,
        source_path: "/synthetic/approved-source".into(),
        provider_relative_path: Some(".freshell/references/0".into()),
    }]
}

fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    }
}

#[async_trait]
impl RuntimeBackend for Backend {
    async fn qualify_retained_opencode(
        &self,
        handle: &OwnedRuntimeHandle,
        request: &RetainedStoreCompatibilityRequest,
        _: &std::path::Path,
    ) -> Result<RetainedStoreCompatibilityReceipt, BackendError> {
        assert_eq!(request.provider_store_id, handle.provider_store_id());
        assert_eq!(request.native_session_id, "ses_exact");
        Ok(RetainedStoreCompatibilityReceipt {
            request: request.clone(),
            provider_version: "1.18.21".into(),
            source_schema_fingerprint: "c".repeat(64),
            migration_journal_fingerprint: "d".repeat(64),
            generation: "e".repeat(64),
            row_count: 1,
        })
    }
    async fn observe_initial_auth_volume(
        &self,
        reservation: &crate::registry::OwnedInputReservation,
    ) -> Result<InitialAuthVolumeObservation, BackendError> {
        Ok(reservation
            .prior_observation
            .clone()
            .unwrap_or(InitialAuthVolumeObservation::Absent {
                daemon_id: DockerDaemonId::parse("synthetic-daemon").unwrap(),
            }))
    }
    async fn create_stopped(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<BackendCreated, BackendError> {
        let inputs = spec
            .terminal
            .as_ref()
            .unwrap()
            .provider_launch_context
            .as_ref()
            .unwrap()
            .prepared_inputs
            .as_ref()
            .unwrap();
        let mut state = self.0.lock().unwrap();
        if !state.generations.contains(&inputs.generation_id) && state.generations.len() >= 2 {
            return Err(BackendError::Unavailable(
                "one active and one pending input generation already exist; preserve and reconcile"
                    .into(),
            ));
        }
        if state
            .publishers
            .get(&inputs.generation_id)
            .is_some_and(|owner| owner != &spec.incarnation_id)
        {
            return Err(BackendError::Unavailable(
                "pending input publisher preparation changed".into(),
            ));
        }
        state.generations.insert(inputs.generation_id.clone());
        state
            .publishers
            .insert(inputs.generation_id.clone(), spec.incarnation_id.clone());
        state
            .events
            .push(format!("create:{}", inputs.generation_id));
        Ok(BackendCreated {
            daemon_id: DockerDaemonId::parse("synthetic-daemon").unwrap(),
            container_id: format!(
                "{:x}",
                sha2::Sha256::digest(spec.incarnation_id.as_str().as_bytes())
            ),
            immutable_config_digest: "a".repeat(64),
        })
    }
    async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
        let secret = std::fs::read(handle.runtime_dir().join("secret")).unwrap();
        let id = handle.incarnation_id().clone();
        {
            let mut state = self.0.lock().unwrap();
            state.running.insert(id.clone());
            if state.real_workloads {
                let worker = std::process::Command::new("/bin/sleep")
                    .arg("3600")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                state
                    .workers
                    .insert(id.clone(), OwnedProviderWorker(worker));
            }
        }
        let state = self.0.clone();
        let seed = self.0.lock().unwrap().seeded_host.clone();
        let task = tokio::spawn(async move {
            let boot = seed
                .as_ref()
                .map(|(boot, _)| boot.clone())
                .unwrap_or_default();
            let mut observation = seed.as_ref().map(|(_, launch)| fixture_observation(launch));
            let mut current_epoch = u64::from(seed.is_some());
            let mut current_generation = seed
                .as_ref()
                .map(|(_, launch)| launch.execution_generation)
                .unwrap_or(0);
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let rejected = state.lock().unwrap().reject_inputs;
                let consumed_rejection = state.lock().unwrap().consumed_rejection;
                let result = match envelope.body {
                    HostCommand::Hello {
                        challenge,
                        incarnation_id,
                    } => HostResult::Hello {
                        host_boot_id: boot.clone(),
                        proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                        capabilities: vec![
                            "native-identity-observation-v1".into(),
                            "provider-store-probe-v1".into(),
                            "owned-provider-config-v1".into(),
                        ],
                        effective_limits: limits(),
                    },
                    HostCommand::GrantExecution {
                        native_identity_launch,
                        control_epoch,
                        execution_generation,
                        ..
                    } => {
                        let failed_grant = state.lock().unwrap().fail == Some("grant");
                        if failed_grant {
                            state.lock().unwrap().fail = None;
                            // Exercise the real bounded supervisor exchange.
                            let mut closed = Vec::new();
                            socket.read_to_end(&mut closed).await.unwrap();
                            continue;
                        }
                        if state.lock().unwrap().reject_inputs {
                            write_frame(
                                &mut socket,
                                &HostReply {
                                    request_id: envelope.request_id,
                                    result: Err(RuntimeError::new(
                                        RuntimeErrorCode::ProviderInputsChanged,
                                        "configuration reference selection changed",
                                    )),
                                },
                            )
                            .await
                            .unwrap();
                            continue;
                        }
                        state.lock().unwrap().grants += 1;
                        let launch = native_identity_launch.unwrap();
                        observation = Some(fixture_observation(&launch));
                        current_epoch = control_epoch;
                        current_generation = execution_generation;
                        HostResult::GrantAccepted {
                            native_identity_observation: observation.clone(),
                            opencode_adoption:
                                freshell_runtime_protocol::OpenCodeAdoptionStatus::NotRequired,
                            opencode_transfer_receipt: None,
                            host_boot_id: boot.clone(),
                            worker_pid: 1234,
                            worker_launch_count: 1,
                            fixture_evidence: serde_json::json!({}),
                            native_session_id: Some("ses_exact".into()),
                        }
                    }
                    HostCommand::Status { .. } => HostResult::Status {
                        native_identity_observation: observation.clone(),
                        opencode_adoption:
                            freshell_runtime_protocol::OpenCodeAdoptionStatus::NotRequired,
                        opencode_transfer_receipt: None,
                        host_boot_id: boot.clone(),
                        worker_pid: if rejected { None } else { Some(1234) },
                        worker_launch_count: u64::from(!rejected),
                        max_control_epoch: current_epoch,
                        max_execution_generation: if rejected && !consumed_rejection {
                            0
                        } else if rejected {
                            1
                        } else {
                            current_generation
                        },
                        fixture_evidence: serde_json::json!({}),
                        exited: false,
                        native_session_id: if rejected {
                            None
                        } else {
                            Some("ses_exact".into())
                        },
                    },
                    HostCommand::ProbeRecovery {
                        resume_spec: Some(spec),
                        ..
                    } => {
                        let (available, gate) = {
                            let mut state = state.lock().unwrap();
                            state
                                .recovery_probes
                                .push(spec.provider_session.native_session_id.clone());
                            (
                                state.recovery_probe_available,
                                state.recovery_probe_gate.take(),
                            )
                        };
                        if let Some(gate) = gate {
                            gate.entered.notify_one();
                            gate.release.notified().await;
                        }
                        if available {
                            HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                                evidence_revision: spec.evidence_revision,
                                resume_spec: spec,
                            })
                        } else {
                            HostResult::RecoveryProbe(RecoveryProbe::Blocked {
                                path: RecoveryPath::NativeResume,
                                reason: RecoveryBlockReason::StoreUnreadable,
                                retry_hint: RetryHint {
                                    automatic_after_ms: None,
                                    manual_retry: true,
                                    repair: None,
                                },
                                evidence: vec![
                                    "synthetic provider store is temporarily unavailable".into(),
                                ],
                            })
                        }
                    }
                    HostCommand::Stop { .. } => {
                        let mut state = state.lock().unwrap();
                        state.running.remove(&id);
                        state.workers.remove(&id);
                        HostResult::Stopped
                    }
                    command => panic!("unexpected synthetic host command {command:?}"),
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
        self.0.lock().unwrap().host_tasks.push(task);
        Ok(())
    }
    async fn discard_stopped_provider_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        let mut state = self.0.lock().unwrap();
        assert!(!state.running.contains(handle.incarnation_id()));
        if let Some(owner) = state.publishers.get(&generation(handle)) {
            assert_eq!(
                owner,
                handle.incarnation_id(),
                "cleanup must retain exact publisher ownership"
            );
        }
        state.cleanup_owners.push(handle.incarnation_id().clone());
        state.events.push(format!("discard:{}", generation(handle)));
        if state.cleanup_failures > 0 {
            state.cleanup_failures -= 1;
            return Err(BackendError::Unavailable(
                "synthetic cleanup transient".into(),
            ));
        }
        state.generations.remove(&generation(handle));
        state.publishers.remove(&generation(handle));
        Ok(())
    }
    async fn commit_prepared_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        let registry_path = self.1.join("runtime.sqlite3");
        let conn = rusqlite::Connection::open(registry_path).unwrap();
        let (running, live): (String, String) = conn.query_row("SELECT i.launch_state,s.recovery_state FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id WHERE i.incarnation_id=?1", [handle.incarnation_id().as_str()], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(running, "running");
        assert_eq!(
            live, "live",
            "resumed B cannot complete before verified durable recovery success"
        );
        drop(conn);
        let gate = self.0.lock().unwrap().completion_gate.take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        let mut state = self.0.lock().unwrap();
        let generation = generation(handle);
        state.events.push(format!("release:{generation}"));
        if state.fail == Some("publisher") {
            state.fail = None;
            return Err(BackendError::Unavailable(
                "synthetic publisher transient".into(),
            ));
        }
        state.publishers.remove(&generation);
        Ok(())
    }
    async fn retire_prior_prepared_inputs(
        &self,
        current: &OwnedRuntimeHandle,
        prior: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        if generation(current) == generation(prior) {
            return Ok(());
        }
        let gate = self.0.lock().unwrap().retirement_gate.take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        let mut state = self.0.lock().unwrap();
        assert!(
            !state.running.contains(prior.incarnation_id()),
            "never stop/delete uncertain live prior ownership"
        );
        assert!(state.running.contains(current.incarnation_id()));
        state.events.push(format!(
            "retire:{}:{}",
            generation(current),
            generation(prior)
        ));
        if state.fail == Some("retire") {
            state.fail = None;
            return Err(BackendError::Unavailable(
                "synthetic retirement transient".into(),
            ));
        }
        state.generations.remove(&generation(prior));
        state.publishers.remove(&generation(prior));
        Ok(())
    }
    async fn inspect(&self, h: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
        let gate = {
            let mut state = self.0.lock().unwrap();
            if state.running.contains(h.incarnation_id()) && generation(h) == "grant-2" {
                state.unsettled_replacement_gate.take()
            } else {
                None
            }
        };
        if let Some(gate) = gate {
            {
                let conn = rusqlite::Connection::open(self.1.join("runtime.sqlite3")).unwrap();
                let running: bool = conn
                    .query_row(
                        "SELECT launch_state='running' FROM incarnations WHERE incarnation_id=?1",
                        [h.incarnation_id().as_str()],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(
                    running,
                    "interrupt only after the replacement is durably RUNNING"
                );
            }
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        Ok(BackendInspection {
            state: if self.0.lock().unwrap().running.contains(h.incarnation_id()) {
                BackendRuntimeState::Running
            } else {
                BackendRuntimeState::Exited
            },
            configured_limits: limits(),
        })
    }
    async fn request_stop(&self, handle: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        let mut state = self.0.lock().unwrap();
        if state.termination_unavailable {
            return Err(BackendError::Unavailable(
                "synthetic termination unavailable".into(),
            ));
        }
        assert!(
            !state.consumed_rejection,
            "healthy or consumed retry must not stop a workload"
        );
        state.running.remove(handle.incarnation_id());
        state.workers.remove(handle.incarnation_id());
        state
            .events
            .push(format!("stop-rejected:{}", generation(handle)));
        Ok(())
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("healthy retry must not stop a workload")
    }
    async fn verify_empty(&self, h: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        if self.0.lock().unwrap().termination_unavailable {
            return Err(BackendError::Unavailable(
                "synthetic emptiness unavailable".into(),
            ));
        }
        Ok(!self.0.lock().unwrap().running.contains(h.incarnation_id()))
    }
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        let mut result = vec![];
        for h in handles {
            result.push((h.incarnation_id().clone(), self.inspect(h).await?));
        }
        Ok(result)
    }
    async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
        Ok(limits())
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        Ok(())
    }
}

async fn control_recover(
    socket: &std::path::Path,
    request: RecoverRequest,
) -> Result<RecoveryResult, RuntimeError> {
    let mut stream = tokio::net::UnixStream::connect(socket).await.unwrap();
    let mut envelope = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::Recover(request),
    );
    envelope.auth = Some("synthetic-control-secret".into());
    write_frame(&mut stream, &envelope).await.unwrap();
    let reply: AdminReply = read_frame(&mut stream).await.unwrap();
    match reply.result? {
        AdminResult::Recovery(result) => Ok(result),
        _ => panic!("unexpected actual control recovery reply"),
    }
}

async fn control_listener(supervisor: &Supervisor) -> tokio::task::JoinHandle<()> {
    let owner = supervisor.clone();
    let path = supervisor.config.control_socket_path.clone();
    let listener = UnixListener::bind(&path).unwrap();
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let owner = owner.clone();
            requests.spawn(async move {
                let request = read_frame(&mut socket).await.unwrap();
                let reply = owner.dispatch(request).await;
                write_frame(&mut socket, &reply).await.unwrap();
            });
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task
}

fn fixture_observation(launch: &NativeIdentityLaunch) -> NativeIdentityObservation {
    NativeIdentityObservation {
        native_session_id: "ses_exact".into(),
        incarnation_id: launch.incarnation_id.clone(),
        launch_nonce: launch.launch_nonce.clone(),
        evidence_revision: launch.evidence_revision,
        source: NativeIdentitySource::OpencodeTui,
        evidence_digest: "b".repeat(64),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_opencode_probe_coalesces_failed_evidence_reads_then_recovers_before_exit() {
    let temp = tempfile::tempdir().unwrap();
    let registry_root = temp.path().join("registry");
    let registry = Registry::open(&registry_root, None).unwrap();
    let soul = SoulId::new();
    let daemon = Arc::new(Mutex::new(Daemon::default()));
    let runtime_root = temp.path().join("runtime");
    let host_binary_path = temp.path().join("synthetic-host");
    std::fs::create_dir_all(&runtime_root).unwrap();
    std::fs::write(&host_binary_path, "synthetic-host-artifact").unwrap();

    let config = SupervisorConfig {
        runtime_root: runtime_root.clone(),
        control_socket_path: temp.path().join("control.sock"),
        host_binary_path: host_binary_path.clone(),
        image_ref: format!("sha256:{}", "a".repeat(64)),
        test_run_id: "live-resume-capture".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: temp.path().join("lifecycle.jsonl"),
        admission: crate::admission::AdmissionPolicy::default(),
    };
    let lifecycle_log = config.lifecycle_log.clone();
    let backend = Arc::new(Backend(daemon.clone(), registry_root));
    let supervisor = Supervisor::new(registry.clone(), backend.clone(), config).unwrap();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"terminal-live-resume",
        "streamId":"stream-live-resume",
        "mode":"opencode",
        "program":"opencode",
        "args":[],
        "env":{"HOME":"/home/freshell/provider"},
        "cwd":temp.path(),
        "runAsUid":65534,
        "runAsGid":0,
        "cols":80,
        "rows":24,
        "projectKey":"project-live-resume",
        "workspacePath":temp.path(),
        "providerLaunchContext":context(&soul, 1),
        "providerSecretReferences":references()
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(crate::registry::LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "store-exact".into(),
            native_session_id: None,
            creation_seed_ref: "seed-live-resume".into(),
            request_id: RequestId::new(),
            payload_digest: "live-resume-capture".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "project-live-resume".into(),
            fixture: None,
            terminal: Some(terminal),
            fresh_agent: None,
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let incarnation_id = prepared.incarnation_id.clone();
    let runtime_dir = runtime_root.join(incarnation_id.as_str());
    std::fs::create_dir_all(&runtime_dir).unwrap();
    std::fs::write(runtime_dir.join("secret"), b"synthetic-host-secret").unwrap();
    registry
        .commit_created(
            incarnation_id.clone(),
            crate::registry::BackendCreatedRecord {
                launch_policy: None,
                daemon_id: DockerDaemonId::parse("synthetic-daemon").unwrap(),
                container_id: "d".repeat(64),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                runtime_dir: runtime_dir.clone(),
                host_binary_path,
                immutable_config_digest: "e".repeat(64),
            },
        )
        .await
        .unwrap();
    let boot = HostBootId::new();
    registry
        .commit_execution_grant(incarnation_id.clone(), boot.clone(), limits())
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    let binding = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: incarnation_id.clone(),
            launch_nonce: current.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: current.evidence_revision,
            execution_generation: 1,
            requested_native_session_id: None,
        })
        .await
        .unwrap();
    let observed_fence = registry
        .record_native_session_fenced(
            soul.clone(),
            incarnation_id.clone(),
            "ses_exact".into(),
            current.write_fence(),
        )
        .await
        .unwrap();
    registry
        .record_native_identity_observation(
            soul.clone(),
            fixture_observation(&binding),
            observed_fence,
        )
        .await
        .unwrap();
    daemon.lock().unwrap().seeded_host = Some((boot, binding));
    registry.mark_running(incarnation_id.clone()).await.unwrap();
    let handle = registry.owned_handle(incarnation_id).await.unwrap();
    backend.start_host(&handle).await.unwrap();

    let live = supervisor.probe_recovery(soul.clone()).await.unwrap();
    assert!(matches!(live, RecoveryProbe::ReattachReady { .. }));
    let after_first_probe = registry.recovery_context(soul.clone()).await.unwrap();
    assert_eq!(
        after_first_probe
            .resume_spec
            .as_ref()
            .map(|spec| spec.provider_session.native_session_id.as_str()),
        None,
        "an unverified provider-store read must not become durable resume evidence"
    );
    assert_eq!(daemon.lock().unwrap().recovery_probes, ["ses_exact"]);
    let count_live_resume_events = || {
        std::fs::read_to_string(&lifecycle_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|event| event["event"] == "supervisor.recovery.live_resume_evidence")
            .count()
    };
    assert_eq!(count_live_resume_events(), 1);

    let repeated_live = supervisor.probe_recovery(soul.clone()).await.unwrap();
    assert!(matches!(repeated_live, RecoveryProbe::ReattachReady { .. }));
    assert_eq!(
        daemon.lock().unwrap().recovery_probes,
        ["ses_exact"],
        "unchanged live identity must not repeat a failing provider-store read on every poll"
    );
    assert_eq!(
        count_live_resume_events(),
        1,
        "unchanged failures should not append duplicate lifecycle events"
    );

    tokio::time::sleep(
        crate::recovery::LIVE_RESUME_EVIDENCE_RETRY_INTERVAL + Duration::from_millis(25),
    )
    .await;
    let gate = Arc::new(RecoveryProbeGate::default());
    {
        let mut daemon = daemon.lock().unwrap();
        daemon.recovery_probe_available = true;
        daemon.recovery_probe_gate = Some(gate.clone());
    }
    let entered = gate.entered.notified();
    let delayed_probe_supervisor = supervisor.clone();
    let delayed_probe_soul = soul.clone();
    let delayed_probe = tokio::spawn(async move {
        delayed_probe_supervisor
            .probe_recovery(delayed_probe_soul)
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(5), entered)
        .await
        .expect("the successful provider-store read reaches its gate");

    // A newer store observation wins while the older provider read is still
    // in flight. Releasing the delayed result must leave this position intact.
    let mut newer =
        crate::resume_catalog::exact_resume_candidate(&after_first_probe, Some("ses_exact"))
            .unwrap()
            .expect("the observed native session has an exact candidate");
    newer.durable_position.provider_cursor = Some("position-after-delayed-probe".into());
    let newer = registry
        .store_verified_resume_spec(soul.clone(), newer)
        .await
        .unwrap();
    gate.release.notify_one();

    let retried_live = tokio::time::timeout(Duration::from_secs(5), delayed_probe)
        .await
        .expect("the delayed provider-store read completes")
        .unwrap();
    assert!(matches!(retried_live, RecoveryProbe::ReattachReady { .. }));
    let durable = registry.recovery_context(soul.clone()).await.unwrap();
    assert_eq!(
        durable
            .resume_spec
            .as_ref()
            .map(|spec| spec.provider_session.native_session_id.as_str()),
        Some("ses_exact"),
        "a newer exact-session proof stays durable while an older read finishes"
    );
    let retained = durable.resume_spec.as_ref().expect("newer proof is saved");
    assert_eq!(retained.evidence_revision, newer.evidence_revision);
    assert_eq!(
        retained.durable_position.provider_cursor.as_deref(),
        Some("position-after-delayed-probe")
    );
    assert_eq!(
        daemon.lock().unwrap().recovery_probes,
        ["ses_exact", "ses_exact"]
    );
    assert_eq!(count_live_resume_events(), 2);

    daemon
        .lock()
        .unwrap()
        .running
        .remove(durable.prior_handle.incarnation_id());
    let after_exit = supervisor.probe_recovery(soul).await.unwrap();
    assert!(matches!(
        after_exit,
        RecoveryProbe::ResumeReady { resume_spec, .. }
            if resume_spec.provider_session.native_session_id == "ses_exact"
    ));

    let tasks = std::mem::take(&mut daemon.lock().unwrap().host_tasks);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_accepted_completion_retries_after_registry_success_on_fresh_healthy_startup() {
    for failure in ["controller", "publisher", "retire"] {
        Box::pin(provider_completion_fixture(failure)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_auxiliary_cleanup_stop_interrupts_initial_commit() {
    Box::pin(provider_auxiliary_cleanup_stop_fixture("initial")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_auxiliary_cleanup_stop_interrupts_resumed_commit() {
    Box::pin(provider_auxiliary_cleanup_stop_fixture("resumed")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_auxiliary_cleanup_stop_interrupts_prior_retirement() {
    Box::pin(provider_auxiliary_cleanup_stop_fixture("retirement")).await;
}

async fn provider_auxiliary_cleanup_stop_fixture(stage: &str) {
    let temp = tempfile::tempdir().unwrap();
    let registry_root = temp.path().join("registry");
    let registry = Registry::open(&registry_root, None).unwrap();
    let soul = SoulId::new();
    let daemon = Arc::new(Mutex::new(Daemon {
        real_workloads: true,
        recovery_probe_available: true,
        ..Default::default()
    }));
    let callback = UnixListener::bind(temp.path().join("mcp.sock")).unwrap();
    let callback_soul = soul.clone();
    let callback_task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = callback.accept().await.unwrap();
            let mut raw = Vec::new();
            stream.read_to_end(&mut raw).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            let response = if request["action"] == "issue" {
                serde_json::to_vec(&PreparedProviderContext {
                    provider_launch_context: context(&callback_soul, 2),
                    provider_secret_references: references(),
                })
                .unwrap()
            } else {
                b"ok".to_vec()
            };
            let _ = stream.write_all(&response).await;
        }
    });
    let binary = temp.path().join("synthetic-host");
    std::fs::write(&binary, "synthetic-host-artifact").unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(Backend(daemon.clone(), registry_root)),
        SupervisorConfig {
            runtime_root: temp.path().join("runtime"),
            control_socket_path: temp.path().join("control.sock"),
            host_binary_path: binary,
            image_ref: format!("sha256:{}", "a".repeat(64)),
            test_run_id: "provider-cleanup-stop".into(),
            control_secret: "synthetic-control-secret".into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"terminal-cleanup-stop", "streamId":"stream-cleanup-stop",
        "mode":"opencode", "program":"opencode", "args":[], "env":{"HOME":"/home/freshell/provider"},
        "cwd":temp.path(), "workspacePath":temp.path(), "runAsUid":65534, "runAsGid":0,
        "cols":80, "rows":24, "projectKey":"project-cleanup-stop",
        "providerLaunchContext":context(&soul,1), "providerSecretReferences":references()
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "store-exact".into(),
            native_session_id: None,
            creation_seed_ref: "cleanup-stop".into(),
            request_id: RequestId::new(),
            payload_digest: "cleanup-stop".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "project-cleanup-stop".into(),
            fixture: None,
            terminal: Some(terminal.clone()),
            fresh_agent: None,
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let workload = LaunchWorkload {
        soul_id: soul.clone(),
        fixture: None,
        terminal: Some(terminal.clone()),
        fresh_agent: None,
        resume_spec: None,
    };
    let gate = Arc::new(RecoveryProbeGate::default());
    let owner = supervisor.clone();
    let mut operation = if stage == "initial" {
        daemon.lock().unwrap().completion_gate = Some(gate.clone());
        tokio::spawn(async move {
            // The ordinary launch owner holds this same lifecycle guard across
            // activation, including acceptance-confirmed auxiliary completion.
            let lock = owner.lifecycle_lock(&workload.soul_id).await;
            let _held = lock.lock().await;
            owner
                .activate_prepared(prepared, workload, limits())
                .await
                .map(|_| ())
        })
    } else {
        let first = supervisor
            .activate_prepared(prepared, workload, limits())
            .await
            .unwrap();
        let resume =
            freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store-exact",
                native_session_id: "ses_exact",
                terminal: &terminal,
                provider_version: Some("1.18.21".into()),
                creation_seed_ref: "cleanup-stop".into(),
                checkpoint_revision: 0,
                evidence_revision: 0,
                never_dispatched: false,
            })
            .unwrap();
        registry
            .store_verified_resume_spec(soul.clone(), resume)
            .await
            .unwrap();
        {
            let mut state = daemon.lock().unwrap();
            state.running.remove(&first.view.incarnation_id);
            state.workers.remove(&first.view.incarnation_id);
            if stage == "retirement" {
                state.retirement_gate = Some(gate.clone());
            } else {
                state.completion_gate = Some(gate.clone());
            }
        }
        let recovery_soul = soul.clone();
        tokio::spawn(async move {
            owner
                .recover(RecoverRequest {
                    soul_id: recovery_soul,
                    trigger: RecoveryTrigger::HostUnreachable,
                    expected_intent_revision: None,
                    expected_control_epoch: None,
                })
                .await
                .map(|_| ())
        })
    };
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    assert_eq!(current.recovery_state, RecoveryState::Live);
    let incarnation = current.prior_handle.incarnation_id().clone();
    let pid = daemon
        .lock()
        .unwrap()
        .workers
        .get(&incarnation)
        .unwrap()
        .0
        .id();
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0);
    let grants = daemon.lock().unwrap().grants;
    let stopper = supervisor.clone();
    let stop_soul = soul.clone();
    let mut stopping = tokio::spawn(async move { stopper.stop(stop_soul, None).await });
    let completed = tokio::time::timeout(Duration::from_secs(2), &mut stopping).await;
    let stopped_before_release = completed.is_ok();
    let worker_reaped_before_release = unsafe { libc::kill(pid as libc::pid_t, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    // Eligibility deliberately excludes a stopped soul; inspect the durable
    // pending bit itself so cancellation cannot masquerade as completion.
    let pending_before_release: bool = rusqlite::Connection::open(registry.database_path())
        .unwrap()
        .query_row(
            "SELECT provider_preparation_pending FROM incarnations WHERE incarnation_id=?1",
            [incarnation.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    let generations_before_release = daemon.lock().unwrap().generations.clone();
    // Settle even the pre-fix failure before asserting, so the actual owned
    // child and authenticated host tasks cannot escape a red regression.
    gate.release.notify_one();
    let stopped = match completed {
        Ok(result) => result.unwrap().unwrap(),
        Err(_) => tokio::time::timeout(Duration::from_secs(5), &mut stopping)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    };
    let operation_result = tokio::time::timeout(Duration::from_secs(5), &mut operation)
        .await
        .unwrap()
        .unwrap();
    let grants_after = daemon.lock().unwrap().grants;
    let publishers_after = daemon.lock().unwrap().publishers.clone();
    callback_task.abort();
    let _ = callback_task.await;
    let tasks = std::mem::take(&mut daemon.lock().unwrap().host_tasks);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    assert!(
        stopped_before_release,
        "{stage}: Stop must reach the workload while auxiliary helper removal remains blocked"
    );
    assert!(
        worker_reaped_before_release,
        "{stage}: desired STOPPED alone is insufficient; the real child must be reaped"
    );
    assert_eq!(stopped.0, StopOutcome::VerifiedEmpty);
    assert!(
        pending_before_release,
        "interrupted cleanup must remain durably pending"
    );
    assert_eq!(
        grants_after, grants,
        "Stop cannot dispatch another provider"
    );
    assert!(generations_before_release.contains("grant-1"));
    if stage != "initial" {
        assert!(generations_before_release.contains("grant-2"));
    }
    if stage != "retirement" {
        assert_eq!(
            publishers_after.get(if stage == "initial" {
                "grant-1"
            } else {
                "grant-2"
            }),
            Some(&incarnation)
        );
    }
    assert_eq!(
        operation_result.unwrap_err().code,
        RuntimeErrorCode::StaleIntentRevision
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_completion_recovers_running_unsettled_replacement_on_fresh_startup() {
    Box::pin(provider_completion_fixture("unsettled")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_replacement_replays_preparation_into_next_incarnation_and_commits() {
    if handoff_timeout_child("service::provider_preparation_tests::failed_replacement_replays_preparation_into_next_incarnation_and_commits").await {
        return;
    }
    Box::pin(provider_completion_fixture("grant")).await;
    Box::pin(provider_completion_fixture("cleanup")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_replacement_cleanup_preserves_automatic_retry_after_second_transient_failure() {
    if handoff_timeout_child("service::provider_preparation_tests::failed_replacement_cleanup_preserves_automatic_retry_after_second_transient_failure").await {
        return;
    }
    Box::pin(provider_completion_fixture("cleanup-automatic")).await;
}

async fn handoff_timeout_child(test_name: &'static str) -> bool {
    const CHILD: &str = "FRESHELL_PROVIDER_HANDOFF_TIMEOUT_CHILD";
    if std::env::var(CHILD).as_deref() != Ok("1") {
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", test_name, "--nocapture"])
                .env(CHILD, "1")
                .env(HOST_COMMAND_TIMEOUT_ENV, "100")
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return true;
    }
    false
}

async fn automatic_provider_cleanup_retry(
    supervisor: &Supervisor,
    soul: &SoulId,
    failed: &OwnedRuntimeHandle,
    daemon: &Mutex<Daemon>,
    clock: &AtomicI64,
    intent_revision: u64,
) -> IncarnationId {
    let retry = supervisor
        .registry
        .recovery_retry(soul.clone(), intent_revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry.attempt_count, 1);
    assert_eq!(retry.next_due_at_ms, Some(2_000));
    assert!(retry.reserved_attempt_id.is_none());
    assert_eq!(
        daemon.lock().unwrap().cleanup_owners,
        vec![failed.incarnation_id().clone()]
    );
    assert_eq!(
        daemon.lock().unwrap().publishers.get("grant-2"),
        Some(failed.incarnation_id())
    );

    clock.store(2_000, Ordering::SeqCst);
    // The production observer owns and joins each scheduled recovery task.
    // Awaiting the pass proves settlement before inspecting its durable row.
    Box::pin(supervisor.observe_once()).await.unwrap();
    assert_eq!(
        supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .recovery_state,
        RecoveryState::Blocked
    );
    assert_eq!(
        daemon.lock().unwrap().cleanup_owners,
        vec![failed.incarnation_id().clone(); 2]
    );
    assert_eq!(
        daemon.lock().unwrap().publishers.get("grant-2"),
        Some(failed.incarnation_id()),
        "another cleanup error must preserve the exact failed publisher"
    );
    assert_eq!(
        daemon.lock().unwrap().events.last().unwrap(),
        "discard:grant-2",
        "cleanup failure must refuse before successor publication"
    );

    let retry = supervisor
        .registry
        .recovery_retry(soul.clone(), intent_revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        retry.attempt_count, 2,
        "the second cleanup failure must settle an actual reserved automatic attempt"
    );
    assert!(retry.reserved_attempt_id.is_none());
    assert_eq!(
        retry.next_due_at_ms,
        Some(12_000),
        "another transient cleanup failure must preserve its bounded automatic retry deadline"
    );
    assert_eq!(retry.last_reason, "backend_unavailable");
    let events_before = daemon.lock().unwrap().events.clone();
    clock.store(11_999, Ordering::SeqCst);
    assert!(supervisor
        .registry
        .due_recovery_retries(11_999)
        .await
        .unwrap()
        .is_empty());
    Box::pin(supervisor.observe_once()).await.unwrap();
    assert_eq!(
        supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .recovery_state,
        RecoveryState::Blocked
    );
    assert_eq!(
        daemon.lock().unwrap().events,
        events_before,
        "scheduled recovery must wait for its persisted deadline"
    );

    clock.store(12_000, Ordering::SeqCst);
    assert_eq!(
        supervisor
            .registry
            .due_recovery_retries(12_000)
            .await
            .unwrap(),
        vec![(soul.clone(), intent_revision)]
    );
    Box::pin(supervisor.observe_once()).await.unwrap();
    let recovered = supervisor
        .registry
        .recovery_context(soul.clone())
        .await
        .unwrap();
    assert_eq!(recovered.recovery_state, RecoveryState::Live);
    assert_eq!(
        recovered.intent_revision, intent_revision,
        "automatic recovery must not rearm intent through ManualRetry"
    );
    assert!(
        supervisor
            .registry
            .recovery_retry(soul.clone(), intent_revision)
            .await
            .unwrap()
            .is_none(),
        "accepted scheduled recovery must settle its retry record"
    );
    let accepted = supervisor
        .registry
        .active_handle_for_soul(soul.clone())
        .await
        .unwrap();
    assert_eq!(
        accepted.incarnation_id(),
        recovered.prior_handle.incarnation_id()
    );
    accepted.incarnation_id().clone()
}

async fn provider_completion_fixture(failure: &'static str) {
    let interrupted_settlement = failure == "unsettled";
    let automatic_cleanup = failure == "cleanup-automatic";
    let transient_cleanup_failure = matches!(failure, "cleanup" | "cleanup-automatic");
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("registry");
    let mut registry = Registry::open(&root, None).unwrap();
    let clock = Arc::new(AtomicI64::new(0));
    if automatic_cleanup {
        registry.retry_clock = Some(clock.clone());
    }
    let soul = SoulId::new();
    let daemon = Arc::new(Mutex::new(Daemon::default()));
    let callback = UnixListener::bind(temp.path().join("mcp.sock")).unwrap();
    let callback_daemon = daemon.clone();
    let callback_soul = soul.clone();
    let callback_task = tokio::spawn(async move {
        let mut next = 1;
        let mut pending = None;
        loop {
            let (mut socket, _) = callback.accept().await.unwrap();
            let mut raw = vec![];
            socket.read_to_end(&mut raw).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&raw).unwrap();
            let response = if request["action"] == "issue" {
                if pending.is_none() {
                    next += 1;
                    pending = Some(next);
                }
                serde_json::to_vec(&PreparedProviderContext {
                    provider_launch_context: context(&callback_soul, next),
                    provider_secret_references: references(),
                })
                .unwrap()
            } else {
                let mut state = callback_daemon.lock().unwrap();
                state.events.push(format!(
                    "{}:{}",
                    request["action"].as_str().unwrap(),
                    request["grantId"].as_str().unwrap()
                ));
                if request["action"] == "commit" && state.fail == Some("controller") {
                    state.fail = None;
                    b"failed".to_vec()
                } else {
                    if request["action"] == "commit" {
                        pending = None;
                    }
                    b"ok".to_vec()
                }
            };
            socket.write_all(&response).await.unwrap();
        }
    });
    let config = SupervisorConfig {
        runtime_root: temp.path().join("runtime"),
        control_socket_path: temp.path().join("control.sock"),
        host_binary_path: temp.path().join("synthetic-host"),
        image_ref: format!("sha256:{}", "a".repeat(64)),
        test_run_id: "provider-completion".into(),
        control_secret: "synthetic-control-secret".into(),
        lifecycle_log: temp.path().join("lifecycle.jsonl"),
        admission: crate::admission::AdmissionPolicy::default(),
    };
    std::fs::write(&config.host_binary_path, "synthetic-host-artifact").unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(Backend(daemon.clone(), root.clone())),
        config.clone(),
    )
    .unwrap();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({"terminalId":"terminal","streamId":"stream","mode":"opencode","program":"opencode","args":[],"env":{"HOME":"/home/freshell/provider"},"cwd":temp.path(),"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"project","workspacePath":temp.path(),"providerLaunchContext":context(&soul,1),"providerSecretReferences":references()})).unwrap();
    let preparation = LaunchPreparation {
        soul_id: soul.clone(),
        provider: "opencode".into(),
        provider_store_id: "store-exact".into(),
        native_session_id: None,
        creation_seed_ref: "seed".into(),
        request_id: RequestId::new(),
        payload_digest: "test-digest".into(),
        requested_limits: limits(),
        profile: RuntimeProfile::Custom,
        project_key: "project".into(),
        fixture: None,
        terminal: Some(terminal.clone()),
        fresh_agent: None,
        view_intent: None,
        admission: crate::admission::AdmissionPolicy::default(),
    };
    let prepared = registry.prepare_launch(preparation.clone()).await.unwrap();
    daemon.lock().unwrap().fail = Some("publisher");
    assert!(supervisor
        .activate_prepared(
            prepared.clone(),
            LaunchWorkload {
                soul_id: soul.clone(),
                fixture: None,
                terminal: Some(terminal.clone()),
                fresh_agent: None,
                resume_spec: None
            },
            limits(),
        )
        .await
        .is_err());
    assert_eq!(daemon.lock().unwrap().grants, 1);
    assert!(!daemon.lock().unwrap().publishers.is_empty());
    let retried = registry.prepare_launch(preparation).await.unwrap();
    assert_eq!(retried.state, LaunchState::Running);
    let first = supervisor
        .activate_prepared(
            retried,
            LaunchWorkload {
                soul_id: soul.clone(),
                fixture: None,
                terminal: Some(terminal.clone()),
                fresh_agent: None,
                resume_spec: None,
            },
            limits(),
        )
        .await
        .unwrap();
    assert_eq!(
        daemon.lock().unwrap().grants,
        1,
        "healthy initial retry does not dispatch twice"
    );
    assert!(
        daemon.lock().unwrap().publishers.is_empty(),
        "healthy initial retry completes publisher release"
    );
    let spec = freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
        provider: "opencode",
        provider_store_id: "store-exact",
        native_session_id: "ses_exact",
        terminal: &terminal,
        provider_version: Some("1.18.21".into()),
        creation_seed_ref: "seed".into(),
        checkpoint_revision: 0,
        evidence_revision: 0,
        never_dispatched: false,
    })
    .unwrap();
    registry
        .store_verified_resume_spec(soul.clone(), spec)
        .await
        .unwrap();
    daemon
        .lock()
        .unwrap()
        .running
        .remove(&first.view.incarnation_id);
    let failed_grant = failure == "grant" || transient_cleanup_failure;
    daemon.lock().unwrap().fail = Some(if failed_grant { "grant" } else { failure });
    let unsettled_gate = Arc::new(RecoveryProbeGate::default());
    if interrupted_settlement {
        daemon.lock().unwrap().unsettled_replacement_gate = Some(unsettled_gate.clone());
    }
    if transient_cleanup_failure {
        daemon.lock().unwrap().cleanup_failures = 2;
    }
    daemon.lock().unwrap().recovery_probe_available = true;
    let request = || RecoverRequest {
        soul_id: soul.clone(),
        trigger: RecoveryTrigger::HostUnreachable,
        expected_intent_revision: None,
        expected_control_epoch: None,
    };
    let mut control = control_listener(&supervisor).await;
    if interrupted_settlement {
        let socket = supervisor.config.control_socket_path.clone();
        let request = request();
        let client = tokio::spawn(async move { control_recover(&socket, request).await });
        tokio::time::timeout(Duration::from_secs(5), unsettled_gate.entered.notified())
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        assert_eq!(context.recovery_state, RecoveryState::Recovering);
        let conn = rusqlite::Connection::open(registry.database_path()).unwrap();
        let (pending, unfinished): (bool, bool) = conn.query_row("SELECT i.provider_preparation_pending,a.finished_at IS NULL AND a.verdict='replacement_prepared' FROM incarnations i JOIN recovery_attempts a ON a.attempt_id=i.recovery_attempt_id WHERE i.incarnation_id=?1", [context.prior_handle.incarnation_id().as_str()], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert!(!pending);
        assert!(unfinished);
        drop(conn);
        // Dropping the authenticated dispatch cancels its recovery future at
        // the real post-launch inspection boundary, before registry settlement.
        control.abort();
        let _ = (&mut control).await;
        client.abort();
        let _ = client.await;
    } else {
        let failed = control_recover(&supervisor.config.control_socket_path, request()).await;
        if failed_grant {
            assert_eq!(failed.unwrap().outcome, RecoveryOutcome::Blocked);
        } else {
            assert!(
                failed.is_err(),
                "injected completion failure must reach actual recovery owner: {failed:?}"
            );
        }
    }
    if failed_grant {
        let failed = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .prior_handle;
        assert!(!daemon
            .lock()
            .unwrap()
            .running
            .contains(failed.incarnation_id()));
        if transient_cleanup_failure && !automatic_cleanup {
            assert_eq!(
                daemon.lock().unwrap().cleanup_owners,
                vec![failed.incarnation_id().clone()]
            );
            assert_eq!(
                daemon.lock().unwrap().publishers.get("grant-2"),
                Some(failed.incarnation_id())
            );
            let events_before = daemon.lock().unwrap().events.clone();
            daemon.lock().unwrap().termination_unavailable = true;
            let refused = control_recover(
                &supervisor.config.control_socket_path,
                RecoverRequest {
                    trigger: RecoveryTrigger::ManualRetry,
                    ..request()
                },
            )
            .await
            .unwrap();
            assert_eq!(refused.outcome, RecoveryOutcome::Blocked);
            assert_eq!(
                daemon.lock().unwrap().events,
                events_before,
                "unverified termination cannot discard inputs or create a successor"
            );
            assert_eq!(
                daemon.lock().unwrap().cleanup_owners,
                vec![failed.incarnation_id().clone()]
            );
            daemon.lock().unwrap().termination_unavailable = false;
            let refused = control_recover(
                &supervisor.config.control_socket_path,
                RecoverRequest {
                    trigger: RecoveryTrigger::ManualRetry,
                    ..request()
                },
            )
            .await
            .unwrap();
            assert_eq!(refused.outcome, RecoveryOutcome::Blocked);
            assert_eq!(
                daemon.lock().unwrap().cleanup_owners,
                vec![
                    failed.incarnation_id().clone(),
                    failed.incarnation_id().clone()
                ]
            );
            assert_eq!(
                daemon.lock().unwrap().publishers.get("grant-2"),
                Some(failed.incarnation_id()),
                "another cleanup error must preserve the failed publisher for a later retry"
            );
            assert_eq!(
                daemon.lock().unwrap().events.last().unwrap(),
                "discard:grant-2",
                "cleanup failure must refuse before successor publication"
            );
        }
        let retried_incarnation = if automatic_cleanup {
            Box::pin(automatic_provider_cleanup_retry(
                &supervisor,
                &soul,
                &failed,
                &daemon,
                &clock,
                first.view.intent_revision,
            ))
            .await
        } else {
            let retried = control_recover(
                &supervisor.config.control_socket_path,
                RecoverRequest {
                    trigger: RecoveryTrigger::ManualRetry,
                    ..request()
                },
            )
            .await
            .expect("the retained preparation must pass the next incarnation's publisher boundary");
            assert_eq!(
                retried.outcome,
                RecoveryOutcome::Replaced,
                "{retried:?}; {:?}",
                daemon.lock().unwrap().events
            );
            retried.view.incarnation_id
        };
        assert_ne!(&retried_incarnation, failed.incarnation_id());
        assert_eq!(
            generation(&registry.active_handle_for_soul(soul.clone()).await.unwrap()),
            generation(&failed)
        );
        if transient_cleanup_failure {
            assert_eq!(
                daemon.lock().unwrap().cleanup_owners,
                vec![
                    failed.incarnation_id().clone(),
                    failed.incarnation_id().clone(),
                    failed.incarnation_id().clone()
                ],
                "cleanup must retry against the failed owner before publication moves"
            );
        }
    }
    let live = registry
        .recovery_context(soul.clone())
        .await
        .unwrap()
        .prior_handle;
    let view = registry
        .inventory()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.incarnation_id == *live.incarnation_id())
        .unwrap();
    assert_eq!(view.launch_state, LaunchState::Running);
    assert_eq!(
        view.recovery_state,
        if interrupted_settlement {
            RecoveryState::Recovering
        } else {
            RecoveryState::Live
        }
    );
    assert_eq!(view.native_session_id.as_deref(), Some("ses_exact"));
    assert_eq!(
        daemon.lock().unwrap().generations.len(),
        if failed_grant { 1 } else { 2 }
    );
    assert_eq!(daemon.lock().unwrap().grants, 2);
    if !interrupted_settlement {
        control.abort();
        let _ = control.await;
    }
    std::fs::remove_file(&supervisor.config.control_socket_path).unwrap();
    drop(supervisor);
    drop(registry);
    let registry = Registry::open(&root, None).unwrap();
    let cold = Supervisor::new(
        registry.clone(),
        Arc::new(Backend(daemon.clone(), root.clone())),
        config,
    )
    .unwrap();
    let startup = Box::pin(cold.reconcile_startup()).await.unwrap();
    assert!(startup.results.iter().all(|v| v.error.is_none()));
    let after = registry.active_handle_for_soul(soul.clone()).await.unwrap();
    assert_eq!(after.incarnation_id(), live.incarnation_id());
    assert_eq!(
        daemon.lock().unwrap().grants,
        2,
        "accepted conversation must not be redispatched"
    );
    assert_eq!(
        daemon.lock().unwrap().generations,
        BTreeSet::from(["grant-2".into()]),
        "healthy fresh startup must retire only prior A"
    );
    assert!(
        daemon.lock().unwrap().publishers.is_empty(),
        "accepted B publisher must be released"
    );
    for event in [
        "commit:grant-2",
        "release:grant-2",
        "retire:grant-2:grant-1",
    ] {
        assert!(
            daemon
                .lock()
                .unwrap()
                .events
                .iter()
                .any(|observed| observed == event),
            "healthy reopen must finish {event}"
        );
    }
    let events_before = daemon.lock().unwrap().events.len();
    let control = control_listener(&cold).await;
    assert_eq!(
        control_recover(&cold.config.control_socket_path, request())
            .await
            .unwrap()
            .outcome,
        RecoveryOutcome::Reattached
    );
    assert_eq!(
        daemon.lock().unwrap().events.len(),
        events_before,
        "completed preparation is not retried on every healthy poll"
    );
    daemon
        .lock()
        .unwrap()
        .running
        .remove(after.incarnation_id());
    let next = control_recover(&cold.config.control_socket_path, request())
        .await
        .unwrap();
    assert_eq!(
        next.outcome,
        RecoveryOutcome::Replaced,
        "next valid C must fit the unchanged active/pending bound"
    );
    assert_eq!(
        daemon.lock().unwrap().generations,
        BTreeSet::from(["grant-3".into()])
    );
    assert_eq!(daemon.lock().unwrap().grants, 3);
    assert!(
        !daemon
            .lock()
            .unwrap()
            .cleanup_owners
            .contains(live.incarnation_id()),
        "an accepted earlier generation must use retirement, never failed-start cleanup"
    );
    control.abort();
    let _ = control.await;
    drop(cold);
    drop(registry);
    callback_task.abort();
    let _ = callback_task.await;
    let tasks = std::mem::take(&mut daemon.lock().unwrap().host_tasks);
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test]
async fn provider_initial_changed_inputs_requires_unconsumed_host_and_settled_owned_cleanup() {
    for consumed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let soul = SoulId::new();
        let daemon = Arc::new(Mutex::new(Daemon {
            reject_inputs: true,
            consumed_rejection: consumed,
            ..Default::default()
        }));
        daemon
            .lock()
            .unwrap()
            .generations
            .insert("prior-usable".into());
        let callback = UnixListener::bind(temp.path().join("mcp.sock")).unwrap();
        let callback_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = callback.accept().await.unwrap();
                let mut raw = vec![];
                stream.read_to_end(&mut raw).await.unwrap();
                stream.write_all(b"ok").await.unwrap();
            }
        });
        let config = SupervisorConfig {
            runtime_root: temp.path().join("runtime"),
            control_socket_path: temp.path().join("control.sock"),
            host_binary_path: temp.path().join("synthetic-host"),
            image_ref: format!("sha256:{}", "a".repeat(64)),
            test_run_id: "provider-initial-replan".into(),
            control_secret: "synthetic-control-secret".into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        };
        std::fs::write(&config.host_binary_path, "synthetic-host-artifact").unwrap();
        let supervisor = Supervisor::new(
            registry.clone(),
            Arc::new(Backend(daemon.clone(), root)),
            config.clone(),
        )
        .unwrap();
        let reservation = registry
            .reserve_initial_inputs(
                ReserveProviderInputsRequest {
                    expected_control_epoch: Some(registry.control_epoch()),
                    soul_id: soul.clone(),
                    provider: "opencode".into(),
                    creation_seed_ref: "seed".into(),
                },
                config.image_ref.clone(),
                config.host_binary_path.clone(),
            )
            .await
            .unwrap();
        let receipt = registry
            .record_initial_observation(
                reservation,
                InitialAuthVolumeObservation::Absent {
                    daemon_id: DockerDaemonId::parse("synthetic-daemon").unwrap(),
                },
            )
            .await
            .unwrap();
        let mut input = context(&soul, 1);
        input
            .prepared_inputs
            .as_mut()
            .unwrap()
            .initial_auth_reservation = Some(receipt.reservation_id.clone());
        let terminal:TerminalLaunchSpec=serde_json::from_value(serde_json::json!({"terminalId":"terminal","streamId":"stream","mode":"opencode","program":"opencode","args":[],"env":{},"cwd":temp.path(),"runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"project","workspacePath":temp.path(),"providerLaunchContext":input,"providerSecretReferences":references()})).unwrap();
        let preparation = LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "store-exact".into(),
            native_session_id: None,
            creation_seed_ref: "seed".into(),
            request_id: RequestId::new(),
            payload_digest: "replan-test".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "project".into(),
            fixture: None,
            terminal: Some(terminal.clone()),
            fresh_agent: None,
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        };
        let prepared = registry.prepare_launch(preparation.clone()).await.unwrap();
        let error = supervisor
            .activate_prepared(
                prepared.clone(),
                LaunchWorkload {
                    soul_id: soul.clone(),
                    fixture: None,
                    terminal: Some(terminal),
                    fresh_agent: None,
                    resume_spec: None,
                },
                limits(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            if consumed {
                RuntimeErrorCode::HostUnreachable
            } else {
                RuntimeErrorCode::ProviderInputsChanged
            }
        );
        let view = registry.inventory().await.unwrap().pop().unwrap();
        assert_eq!(
            view.launch_state,
            if consumed {
                LaunchState::Starting
            } else {
                LaunchState::Stopped
            }
        );
        assert!(daemon.lock().unwrap().generations.contains("prior-usable"));
        assert_eq!(
            daemon.lock().unwrap().generations.contains("grant-1"),
            consumed,
            "only positively rejected generation can be retired"
        );
        assert_eq!(daemon.lock().unwrap().grants, 0);
        if !consumed {
            for ordinal in 2..=3 {
                let reserved = registry
                    .reserve_initial_inputs(
                        ReserveProviderInputsRequest {
                            expected_control_epoch: Some(registry.control_epoch()),
                            soul_id: soul.clone(),
                            provider: "opencode".into(),
                            creation_seed_ref: "seed".into(),
                        },
                        config.image_ref.clone(),
                        config.host_binary_path.clone(),
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    reserved.id, receipt.reservation_id,
                    "replan reuses exact creation authority"
                );
                let retained = reserved.prior_observation.clone().unwrap();
                assert!(
                    matches!(&retained,InitialAuthVolumeObservation::OwnedUndispatched {incarnation_id,..} if incarnation_id==&prepared.incarnation_id)
                );
                registry
                    .record_initial_observation(reserved, retained)
                    .await
                    .unwrap();
                let mut next = preparation.clone();
                next.request_id = RequestId::new();
                next.payload_digest = format!("replan-{ordinal}");
                let mut next_context = context(&soul, ordinal);
                next_context
                    .prepared_inputs
                    .as_mut()
                    .unwrap()
                    .initial_auth_reservation = Some(receipt.reservation_id.clone());
                next.terminal.as_mut().unwrap().provider_launch_context = Some(next_context);
                let workload = LaunchWorkload {
                    soul_id: soul.clone(),
                    fixture: None,
                    terminal: next.terminal.clone(),
                    fresh_agent: None,
                    resume_spec: None,
                };
                let prepared = registry.prepare_launch(next).await.unwrap();
                assert_eq!(
                    supervisor
                        .activate_prepared(prepared, workload, limits())
                        .await
                        .unwrap_err()
                        .code,
                    RuntimeErrorCode::ProviderInputsChanged
                );
                assert_eq!(
                    daemon.lock().unwrap().generations,
                    BTreeSet::from(["prior-usable".to_string()]),
                    "each rejected generation is settled while prior input remains"
                );
            }
            assert!(
                registry
                    .reserve_initial_inputs(
                        ReserveProviderInputsRequest {
                            expected_control_epoch: Some(registry.control_epoch()),
                            soul_id: soul.clone(),
                            provider: "opencode".into(),
                            creation_seed_ref: "seed".into()
                        },
                        config.image_ref.clone(),
                        config.host_binary_path.clone()
                    )
                    .await
                    .is_err(),
                "two pre-dispatch replans are the complete bound"
            );
        }
        let tasks = std::mem::take(&mut daemon.lock().unwrap().host_tasks);
        for task in tasks {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        callback_task.abort();
        assert!(callback_task.await.unwrap_err().is_cancelled());
    }
}
