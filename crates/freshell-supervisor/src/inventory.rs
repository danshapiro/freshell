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
    DesiredState, LaunchState, RecoverRequest, RecoveryOutcome, RecoveryState, RecoveryTrigger,
    RuntimeError, RuntimeErrorCode, SoulId,
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

        for (soul_id, intent_revision) in latest {
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
                    supervisor.recover(RecoverRequest {
                        soul_id: soul_id.clone(),
                        trigger: RecoveryTrigger::StartupReconcile,
                        expected_intent_revision: Some(intent_revision),
                        expected_control_epoch: Some(supervisor.registry.control_epoch()),
                    }),
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

    async fn observe_once(&self) -> Result<(), RuntimeError> {
        let mut latest = BTreeMap::new();
        for view in self.registry.inventory().await.map_err(map_registry)? {
            latest.insert(view.soul_id.clone(), view);
        }
        let mut tasks = JoinSet::new();
        let semaphore = Arc::new(Semaphore::new(startup_concurrency_limit()));
        for (_, view) in latest {
            if view.desired_state != DesiredState::Running
                || view.recovery_state != RecoveryState::Live
                || view.launch_state != LaunchState::Running
            {
                continue;
            }
            let supervisor = self.clone();
            let semaphore = Arc::clone(&semaphore);
            tasks.spawn(async move {
                let _permit = semaphore.acquire_owned().await.map_err(|error| {
                    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error.to_string())
                })?;
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
                                Ok(_) => None,
                                Err(_) => Some(RecoveryTrigger::HostUnreachable),
                            },
                            Err(_) => Some(RecoveryTrigger::HostUnreachable),
                        }
                    }
                    Ok(_) => None,
                    Err(_) => Some(RecoveryTrigger::HostUnreachable),
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

    #[test]
    fn startup_concurrency_defaults_are_bounded() {
        assert_eq!(DEFAULT_STARTUP_RECOVERY_CONCURRENCY, 4);
        assert!(MAX_STARTUP_RECOVERY_CONCURRENCY <= 16);
    }
}
