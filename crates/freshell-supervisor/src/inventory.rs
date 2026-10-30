//! Controller-owned startup reconciliation and continuous liveness observation.
//!
//! The web server is intentionally absent from both loops. On boot the
//! supervisor reconciles every desired-running soul before it exposes its
//! authenticated control socket. Afterwards a bounded observer watches only
//! registry-issued ownership handles and routes failures through the same
//! fenced recovery transaction used by explicit requests.

use crate::{
    backend::BackendRuntimeState,
    service::{append_event, Supervisor},
};
use freshell_runtime_protocol::{
    DesiredState, DurabilityState, LaunchState, RecoverRequest, RecoveryOutcome, RecoveryState,
    RecoveryTrigger, RuntimeError, RuntimeErrorCode, SoulId,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::Semaphore, task::JoinSet};

pub const DEFAULT_STARTUP_RECOVERY_CONCURRENCY: usize = 4;
const MAX_STARTUP_RECOVERY_CONCURRENCY: usize = 16;
const DEFAULT_STARTUP_SOUL_TIMEOUT: Duration = Duration::from_secs(180);
const DEFAULT_OBSERVER_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupSoulResult {
    pub soul_id: SoulId,
    pub outcome: Option<RecoveryOutcome>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupReconcileReport {
    pub scanned: usize,
    pub peak_concurrency: u32,
    pub results: Vec<StartupSoulResult>,
}

impl Supervisor {
    /// Reconcile every desired-running soul before the control socket becomes
    /// reachable. Individual blocked souls are successful scan results—their
    /// typed recovery state belongs in inventory. Infrastructure errors and
    /// bounded timeouts mark readiness `blocked` without hiding partial state.
    pub async fn reconcile_startup(&self) -> Result<StartupReconcileReport, RuntimeError> {
        let scan_started_at = crate::registry::now_millis();
        self.registry
            .mark_startup_scan_started()
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.startup_scan.started",
            serde_json::json!({
                "concurrencyLimit": startup_concurrency_limit(),
            }),
        );

        let due: BTreeMap<_, _> = self
            .registry
            .due_recovery_retries(self.registry.recovery_now_ms())
            .await
            .map_err(map_registry)?
            .into_iter()
            .collect();
        let mut latest = BTreeMap::<SoulId, u64>::new();
        for view in self.registry.inventory().await.map_err(map_registry)? {
            if view.desired_state == DesiredState::Running {
                latest.insert(view.soul_id, view.intent_revision);
            }
        }

        let concurrency = startup_concurrency_limit();
        let semaphore = Arc::new(Semaphore::new(concurrency));
        let active = Arc::new(AtomicU32::new(0));
        let peak = Arc::new(AtomicU32::new(0));
        let timeout = startup_soul_timeout();
        let mut tasks = JoinSet::new();

        for handle in self
            .registry
            .pending_stop_handles()
            .await
            .map_err(map_registry)?
        {
            let supervisor = self.clone();
            let semaphore = Arc::clone(&semaphore);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            tasks.spawn(async move {
                let _permit = semaphore
                    .acquire_owned()
                    .await
                    .map_err(|error| error.to_string())?;
                let observed = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(observed, Ordering::SeqCst);
                let result =
                    tokio::time::timeout(timeout, supervisor.continue_pending_stop(&handle)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok::<_, String>(StartupSoulResult {
                    soul_id: handle.soul_id().clone(),
                    outcome: None,
                    error: match result {
                        Ok(Ok(())) => None,
                        Ok(Err(error)) => Some(error.message),
                        Err(_) => Some(format!("startup Stop exceeded {}ms", timeout.as_millis())),
                    },
                })
            });
        }

        for (soul_id, intent_revision) in latest {
            let only_due_retry = due.contains_key(&soul_id);
            let supervisor = self.clone();
            let semaphore = Arc::clone(&semaphore);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            tasks.spawn(async move {
                let permit = semaphore
                    .acquire_owned()
                    .await
                    .map_err(|error| error.to_string())?;
                let observed = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(observed, Ordering::SeqCst);
                let result = tokio::time::timeout(
                    timeout,
                    supervisor.recover_scheduled(
                        RecoverRequest {
                            soul_id: soul_id.clone(),
                            trigger: RecoveryTrigger::StartupReconcile,
                            expected_intent_revision: Some(intent_revision),
                            expected_control_epoch: Some(supervisor.registry.control_epoch()),
                        },
                        only_due_retry,
                    ),
                )
                .await;
                active.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
                let result = match result {
                    Ok(Ok(recovery)) => StartupSoulResult {
                        soul_id,
                        outcome: Some(recovery.outcome),
                        error: None,
                    },
                    Ok(Err(error)) => StartupSoulResult {
                        soul_id,
                        outcome: None,
                        error: Some(error.message),
                    },
                    Err(_) => StartupSoulResult {
                        soul_id,
                        outcome: None,
                        error: Some(format!(
                            "startup recovery exceeded {}ms",
                            timeout.as_millis()
                        )),
                    },
                };
                Ok::<_, String>(result)
            });
        }

        let mut results = Vec::new();
        let mut blocked_subsystems = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok(Ok(result)) => {
                    if let Some(error) = result.error.as_ref() {
                        blocked_subsystems.push(format!("soul:{}:{error}", result.soul_id));
                    }
                    results.push(result);
                }
                Ok(Err(error)) => blocked_subsystems.push(format!("startup-worker:{error}")),
                Err(error) => blocked_subsystems.push(format!("startup-task:{error}")),
            }
        }
        results.sort_by(|left, right| left.soul_id.as_str().cmp(right.soul_id.as_str()));

        let peak_concurrency = peak.load(Ordering::SeqCst);
        self.registry
            .note_startup_scan_concurrency(peak_concurrency)
            .await
            .map_err(map_registry)?;
        self.registry
            .make_desired_running_views_visible()
            .await
            .map_err(map_registry)?;
        let scan_finished_at = crate::registry::now_millis();
        self.registry
            .coalesce_startup_notices(scan_started_at, scan_finished_at)
            .await
            .map_err(map_registry)?;
        self.registry
            .mark_startup_scan_finished(blocked_subsystems.clone())
            .await
            .map_err(map_registry)?;
        append_event(
            &self.config.lifecycle_log,
            "supervisor.startup_scan.finished",
            serde_json::json!({
                "scanned": results.len(),
                "peakConcurrency": peak_concurrency,
                "blockedSubsystems": blocked_subsystems,
            }),
        );
        Ok(StartupReconcileReport {
            scanned: results.len(),
            peak_concurrency,
            results,
        })
    }

    /// Keep lifecycle ownership in the supervisor after startup. This task
    /// observes only exact registry handles; it never lists arbitrary Docker
    /// objects and never manufactures kill authority from labels or process
    /// names.
    pub fn spawn_runtime_observer(&self) {
        let supervisor = self.clone();
        tokio::spawn(async move {
            let interval = observer_interval();
            loop {
                tokio::time::sleep(interval).await;
                if let Err(error) = supervisor.observe_once().await {
                    append_event(
                        &supervisor.config.lifecycle_log,
                        "supervisor.runtime_observer.error",
                        serde_json::json!({"error": error.message}),
                    );
                }
            }
        });
    }

    /// Run one bounded observation pass through the same lifecycle locks and
    /// persisted retry policy used by the background observer.
    pub async fn observe_once(&self) -> Result<(), RuntimeError> {
        let due: BTreeMap<_, _> = self
            .registry
            .due_recovery_retries(self.registry.recovery_now_ms())
            .await
            .map_err(map_registry)?
            .into_iter()
            .collect();
        let mut latest = BTreeMap::new();
        for view in self.registry.inventory().await.map_err(map_registry)? {
            latest.insert(view.soul_id.clone(), view);
        }
        let mut tasks = JoinSet::new();
        let semaphore = Arc::new(Semaphore::new(startup_concurrency_limit()));
        for handle in self
            .registry
            .pending_stop_handles()
            .await
            .map_err(map_registry)?
        {
            let supervisor = self.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
                })?;
                tokio::time::timeout(
                    startup_soul_timeout(),
                    supervisor.continue_pending_stop(&handle),
                )
                .await
                .map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::BackendUnavailable,
                        "ordinary Stop continuation timed out",
                    )
                })?
            });
        }
        for (_, view) in latest {
            if view.desired_state != DesiredState::Running
                || (!due.contains_key(&view.soul_id)
                    && (view.recovery_state != RecoveryState::Live
                        || view.launch_state != LaunchState::Running))
            {
                continue;
            }
            let retry_due = due.contains_key(&view.soul_id);
            let supervisor = self.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
                })?;
                if retry_due {
                    supervisor
                        .recover_scheduled(
                            RecoverRequest {
                                soul_id: view.soul_id,
                                trigger: RecoveryTrigger::StartupReconcile,
                                expected_intent_revision: Some(view.intent_revision),
                                expected_control_epoch: Some(supervisor.registry.control_epoch()),
                            },
                            true,
                        )
                        .await?;
                    return Ok(());
                }
                let handle = supervisor
                    .registry
                    .active_handle_for_soul(view.soul_id.clone())
                    .await
                    .map_err(map_registry)?;
                let trigger = match supervisor.backend.inspect(&handle).await {
                    Ok(inspection)
                        if matches!(
                            inspection.state,
                            BackendRuntimeState::Missing
                                | BackendRuntimeState::Exited
                                | BackendRuntimeState::Dead
                        ) =>
                    {
                        Some(RecoveryTrigger::ProviderExit)
                    }
                    Ok(inspection) if inspection.state == BackendRuntimeState::Running => {
                        match supervisor
                            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                            .await
                        {
                            Ok(host) => match supervisor
                                .host_status(
                                    handle.incarnation_id().clone(),
                                    handle.runtime_dir(),
                                    &host,
                                )
                                .await
                            {
                                Ok(status) if status.exited => Some(RecoveryTrigger::ProviderExit),
                                Ok(_) => {
                                    if view.provider.as_deref() != Some("shell")
                                        && !matches!(
                                            view.durability_state,
                                            DurabilityState::ResumeCaptured
                                                | DurabilityState::CheckpointCaptured
                                                | DurabilityState::IntrinsicallyNonResumable
                                        )
                                    {
                                        // Publish initial native proof even when nobody reads
                                        // output. The existing probe refreshes ownership under
                                        // the lifecycle lock and reuses the capture retry gate.
                                        supervisor.probe_recovery(view.soul_id.clone()).await?;
                                    }
                                    None
                                }
                                Err(error) => {
                                    append_event(
                                        &supervisor.config.lifecycle_log,
                                        "supervisor.runtime_observer.host_status_failed",
                                        serde_json::json!({"soulId":view.soul_id,"errorCode":error.code,"message":error.message}),
                                    );
                                    Some(RecoveryTrigger::HostUnreachable)
                                }
                            },
                            Err(error) => {
                                append_event(
                                    &supervisor.config.lifecycle_log,
                                    "supervisor.runtime_observer.authenticate_failed",
                                    serde_json::json!({"soulId":view.soul_id,"errorCode":error.code,"message":error.message}),
                                );
                                Some(RecoveryTrigger::HostUnreachable)
                            }
                        }
                    }
                    Ok(_) => None,
                    Err(error) => {
                        append_event(
                            &supervisor.config.lifecycle_log,
                            "supervisor.runtime_observer.inspect_failed",
                            serde_json::json!({"soulId":view.soul_id,"message":error.to_string()}),
                        );
                        Some(RecoveryTrigger::HostUnreachable)
                    }
                };
                if let Some(trigger) = trigger {
                    append_event(
                        &supervisor.config.lifecycle_log,
                        "supervisor.runtime_observer.recovery_scheduled",
                        serde_json::json!({
                            "soulId": view.soul_id,
                            "intentRevision": view.intent_revision,
                            "trigger": trigger,
                        }),
                    );
                    let _ = supervisor
                        .recover(RecoverRequest {
                            soul_id: view.soul_id,
                            trigger,
                            expected_intent_revision: Some(view.intent_revision),
                            expected_control_epoch: Some(supervisor.registry.control_epoch()),
                        })
                        .await?;
                }
                Ok::<(), RuntimeError>(())
            });
        }
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    append_event(
                        &self.config.lifecycle_log,
                        "supervisor.runtime_observer.soul_error",
                        serde_json::json!({"error": error.message}),
                    );
                }
                Err(error) => {
                    append_event(
                        &self.config.lifecycle_log,
                        "supervisor.runtime_observer.task_error",
                        serde_json::json!({"error": error.to_string()}),
                    );
                }
            }
        }
        Ok(())
    }

    async fn continue_pending_stop(
        &self,
        handle: &crate::registry::OwnedRuntimeHandle,
    ) -> Result<(), RuntimeError> {
        let lock = self.lifecycle_lock(handle.soul_id()).await;
        let _guard = lock.lock().await;
        self.finish_stop_handle(handle).await?;
        let progress = self
            .registry
            .stop_progress(handle)
            .await
            .map_err(map_registry)?;
        if !progress.settled {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RecoveryBlocked,
                format!("ordinary Stop remains pending: {:?}", progress.outcome),
            ));
        }
        Ok(())
    }
}

pub(crate) fn startup_concurrency_limit() -> usize {
    std::env::var("FRESHELL_RUNTIME_STARTUP_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_STARTUP_RECOVERY_CONCURRENCY)
        .clamp(1, MAX_STARTUP_RECOVERY_CONCURRENCY)
}

fn startup_soul_timeout() -> Duration {
    let millis = std::env::var("FRESHELL_RUNTIME_STARTUP_SOUL_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_STARTUP_SOUL_TIMEOUT.as_millis() as u64)
        .clamp(1_000, 15 * 60 * 1_000);
    Duration::from_millis(millis)
}

fn observer_interval() -> Duration {
    let millis = std::env::var("FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_OBSERVER_INTERVAL.as_millis() as u64)
        .clamp(250, 60_000);
    Duration::from_millis(millis)
}

fn map_registry(error: crate::registry::RegistryError) -> RuntimeError {
    let code = match error {
        crate::registry::RegistryError::StaleIntentRevision { .. } => {
            RuntimeErrorCode::StaleIntentRevision
        }
        crate::registry::RegistryError::UnknownSoul(_) => RuntimeErrorCode::UnknownSoul,
        _ => RuntimeErrorCode::RegistryFailure,
    };
    RuntimeError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Registry;
    use freshell_runtime_protocol::{
        host_proof, read_frame, write_frame, DurabilityState, Envelope, HostBootId, HostCommand,
        HostReply, HostResult, NativeIdentityLaunch, NativeIdentityObservation,
        NativeIdentitySource, RecoveryProbe,
    };
    use rusqlite::{params, Connection};
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use tokio::{net::UnixListener, task::JoinHandle};

    struct ObserverFixture {
        root: Arc<tempfile::TempDir>,
        supervisor: Supervisor,
        soul: SoulId,
        probes: Arc<AtomicUsize>,
        stale_observation: Arc<AtomicBool>,
        probe_unavailable: Arc<AtomicBool>,
        stop_during_probe: Arc<AtomicBool>,
        peer: JoinHandle<()>,
    }

    impl ObserverFixture {
        async fn new(fresh: bool) -> Self {
            let root = Arc::new(tempfile::tempdir().unwrap());
            let registry = Registry::open(root.path().join("registry"), None).unwrap();
            let soul = SoulId::new();
            let prepared =
                crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
            let runtime = root
                .path()
                .join("runtime")
                .join(prepared.incarnation_id.as_str());
            std::fs::create_dir_all(&runtime).unwrap();
            std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
            let provider_home = root.path().join("provider");
            std::fs::create_dir_all(provider_home.join(".codex/sessions")).unwrap();
            std::fs::write(
                provider_home.join(".codex/sessions/rollout-observer-root.jsonl"),
                b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"observer-root\"}}\n",
            )
            .unwrap();
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            let (terminal, agent) = if fresh {
                (None, Some(serde_json::json!({
                    "sessionId":"observer-fresh", "provider":"codex", "sessionType":"freshcodex",
                    "runtimeVariant":"codex-app-server-v1", "providerStoreId":context.provider_store_id,
                    "cwd":root.path(), "workspacePath":root.path(), "runAsUid":65534, "runAsGid":0
                }).to_string()))
            } else {
                (Some(serde_json::json!({
                    "terminalId":"observer-terminal", "streamId":"observer-stream", "mode":"codex",
                    "program":"codex", "cwd":root.path(), "workspacePath":root.path(),
                    "env":{"HOME":"/home/freshell/provider"},
                    "projectKey":"observer-project", "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24
                }).to_string()), None)
            };
            let conn = Connection::open(registry.database_path()).unwrap();
            conn.execute(
                "UPDATE souls SET provider='codex',native_session_id=NULL,resume_spec=NULL,durability_state='live_only' WHERE soul_id=?1",
                [soul.as_str()],
            ).unwrap();
            conn.execute(
                "UPDATE incarnations SET fixture_kind=NULL,terminal_spec=?1,fresh_agent_spec=?2,runtime_dir=?3,execution_generation=1 WHERE incarnation_id=?4",
                params![terminal, agent, runtime.to_str().unwrap(), prepared.incarnation_id.as_str()],
            ).unwrap();
            drop(conn);
            let context = registry.recovery_context(soul.clone()).await.unwrap();
            let candidate =
                crate::resume_catalog::exact_resume_candidate(&context, Some("observer-root"))
                    .expect("observer fixture must support exact recovery")
                    .expect("observer fixture must have an exact candidate");
            assert!(
                matches!(
                    freshell_agent_runtime::probe_provider_store(&provider_home, &candidate),
                    freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
                ),
                "observer fixture must start with a verifiable exact native store"
            );
            let launch = NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: 1,
                requested_native_session_id: None,
            };
            registry
                .bind_native_identity_launch(launch.clone())
                .await
                .unwrap();
            let supervisor = crate::recovery::tests::supervisor_with_runtime_state(
                &root,
                registry.clone(),
                BackendRuntimeState::Running,
            );
            let probes = Arc::new(AtomicUsize::new(0));
            let stale_observation = Arc::new(AtomicBool::new(false));
            let probe_unavailable = Arc::new(AtomicBool::new(false));
            let stop_during_probe = Arc::new(AtomicBool::new(false));
            let peer = {
                let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
                let probes = Arc::clone(&probes);
                let stale_observation = Arc::clone(&stale_observation);
                let probe_unavailable = Arc::clone(&probe_unavailable);
                let stop_during_probe = Arc::clone(&stop_during_probe);
                let soul = soul.clone();
                tokio::spawn(async move {
                    let boot = HostBootId::new();
                    loop {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                        if !matches!(request.body, HostCommand::Hello { .. }) {
                            assert_eq!(
                                request.auth,
                                Some(host_proof(
                                    b"synthetic-secret",
                                    "command-auth",
                                    &boot,
                                    &launch.incarnation_id,
                                ))
                            );
                        }
                        let result = match request.body {
                            HostCommand::Hello { incarnation_id, challenge } => {
                                assert_eq!(incarnation_id, launch.incarnation_id);
                                Ok(HostResult::Hello {
                                    proof: host_proof(b"synthetic-secret", &challenge, &boot, &incarnation_id),
                                    host_boot_id: boot.clone(),
                                    capabilities: vec![
                                        "owned-provider-config-v1".into(),
                                        "provider-store-probe-v1".into(),
                                        "native-identity-observation-v1".into(),
                                    ],
                                    effective_limits: context.requested_limits,
                                })
                            }
                            HostCommand::Status { incarnation_id } => {
                                assert_eq!(incarnation_id, launch.incarnation_id);
                                Ok(HostResult::Status {
                                    host_boot_id: boot.clone(), worker_pid: Some(42), worker_launch_count: 1,
                                    max_control_epoch: registry.control_epoch(), max_execution_generation: 1,
                                    fixture_evidence: serde_json::json!({}), exited: false,
                                    native_session_id: Some("observer-root".into()),
                                    native_identity_observation: Some(NativeIdentityObservation {
                                        native_session_id: "observer-root".into(),
                                        incarnation_id: if stale_observation.load(Ordering::SeqCst) {
                                            freshell_runtime_protocol::IncarnationId::new()
                                        } else { launch.incarnation_id.clone() },
                                        launch_nonce: launch.launch_nonce.clone(),
                                        evidence_revision: launch.evidence_revision,
                                        source: if fresh { NativeIdentitySource::FreshProviderHandshake }
                                            else { NativeIdentitySource::CodexAppServer },
                                        evidence_digest: "b".repeat(64),
                                    }),
                                    opencode_transfer_receipt: None, opencode_adoption: Default::default(),
                                })
                            }
                            HostCommand::ProbeRecovery { incarnation_id, resume_spec, .. } => {
                                assert_eq!(incarnation_id, launch.incarnation_id);
                                probes.fetch_add(1, Ordering::SeqCst);
                                let spec = resume_spec.expect("the observer must select one exact native root");
                                assert_eq!(spec.provider_session.native_session_id, "observer-root");
                                assert_eq!(spec.provider_session.provider, "codex");
                                assert!(matches!(
                                    freshell_agent_runtime::probe_provider_store(&provider_home, &spec),
                                    freshell_agent_runtime::ProviderStoreProbe::Ready { .. }
                                ), "a real provider store read must verify the requested root");
                                if stop_during_probe.load(Ordering::SeqCst) {
                                    registry.begin_stop(soul.clone()).await.unwrap();
                                }
                                if probe_unavailable.load(Ordering::SeqCst) {
                                    Err(RuntimeError::new(RuntimeErrorCode::HostUnreachable, "synthetic native store transport unavailable"))
                                } else {
                                    Ok(HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                                        evidence_revision: spec.evidence_revision, resume_spec: spec,
                                    }))
                                }
                            }
                            other => panic!("observer evidence must not require output, launch, or Stop commands: {other:?}"),
                        };
                        write_frame(
                            &mut socket,
                            &HostReply {
                                request_id: request.request_id,
                                result,
                            },
                        )
                        .await
                        .unwrap();
                    }
                })
            };
            Self {
                root,
                supervisor,
                soul,
                probes,
                stale_observation,
                probe_unavailable,
                stop_during_probe,
                peer,
            }
        }

        async fn observe(&self) {
            tokio::time::timeout(Duration::from_secs(5), self.supervisor.observe_once())
                .await
                .expect("owned observer pass must settle")
                .unwrap();
            assert!(
                !self.peer.is_finished(),
                "host peer rejected an unexpected command"
            );
        }

        async fn assert_captured(&self) -> freshell_runtime_protocol::ResumeSpec {
            let context = self.context().await;
            let spec = context.resume_spec.unwrap_or_else(|| panic!(
                "observer must durably capture initial resume evidence without an output read; lifecycle: {}",
                std::fs::read_to_string(self.root.path().join("lifecycle.jsonl")).unwrap_or_default()
            ));
            assert_eq!(spec.provider_session.native_session_id, "observer-root");
            assert_eq!(spec.evidence_revision, context.evidence_revision);
            assert_eq!(context.durability_state, DurabilityState::ResumeCaptured);
            assert!(
                context.recovery_attempt_id.is_none(),
                "evidence observation reserves no recovery attempt"
            );
            spec
        }

        async fn context(&self) -> crate::registry::RecoveryContext {
            self.supervisor
                .registry
                .recovery_context(self.soul.clone())
                .await
                .unwrap()
        }
    }

    impl Drop for ObserverFixture {
        fn drop(&mut self) {
            self.peer.abort();
        }
    }

    #[tokio::test]
    async fn observer_captures_verified_resume_evidence_without_output_reads() {
        for fresh in [false, true] {
            let mut fixture = ObserverFixture::new(fresh).await;
            fixture.observe().await;
            let saved = fixture.assert_captured().await;
            fixture.observe().await;
            assert_eq!(
                fixture.probes.load(Ordering::SeqCst),
                1,
                "saved evidence needs no repeated native store read"
            );
            let root = Arc::clone(&fixture.root);
            let soul = fixture.soul.clone();
            fixture.peer.abort();
            let _ = (&mut fixture.peer).await;
            drop(fixture);
            let reopened = Registry::open(root.path().join("registry"), None).unwrap();
            assert_eq!(
                reopened.recovery_context(soul).await.unwrap().resume_spec,
                Some(saved)
            );
        }
    }

    #[tokio::test]
    async fn observer_resume_capture_reuses_failure_cooldown_then_retries() {
        let fixture = ObserverFixture::new(false).await;
        fixture.probe_unavailable.store(true, Ordering::SeqCst);
        fixture.observe().await;
        assert_eq!(fixture.probes.load(Ordering::SeqCst), 1);
        fixture.probe_unavailable.store(false, Ordering::SeqCst);
        fixture.observe().await;
        assert_eq!(
            fixture.probes.load(Ordering::SeqCst),
            1,
            "ordinary passes share the existing capture cooldown"
        );
        assert!(fixture.context().await.resume_spec.is_none());
        tokio::time::sleep(
            crate::recovery::LIVE_RESUME_EVIDENCE_RETRY_INTERVAL + Duration::from_millis(10),
        )
        .await;
        fixture.observe().await;
        fixture.assert_captured().await;
        assert_eq!(fixture.probes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn observer_resume_capture_requires_current_native_owner() {
        let fixture = ObserverFixture::new(false).await;
        fixture.stale_observation.store(true, Ordering::SeqCst);
        fixture.observe().await;
        let context = fixture.context().await;
        assert!(context.native_session_id.is_none());
        assert!(context.resume_spec.is_none());
        assert_eq!(
            fixture.probes.load(Ordering::SeqCst),
            0,
            "stale incarnation cannot authorize a native store proof"
        );
        fixture.stale_observation.store(false, Ordering::SeqCst);
        fixture.observe().await;
        fixture.assert_captured().await;
    }

    #[tokio::test]
    async fn observer_resume_capture_cannot_publish_after_stop_intent() {
        let fixture = ObserverFixture::new(false).await;
        fixture.stop_during_probe.store(true, Ordering::SeqCst);
        fixture.observe().await;
        assert_eq!(fixture.probes.load(Ordering::SeqCst), 1);
        let context = fixture.context().await;
        assert_eq!(context.desired_state, DesiredState::Stopped);
        assert_eq!(context.recovery_state, RecoveryState::Stopped);
        assert!(
            context.resume_spec.is_none(),
            "a verified read cannot publish after durable Stop"
        );
        assert_ne!(context.durability_state, DurabilityState::ResumeCaptured);
    }
}
