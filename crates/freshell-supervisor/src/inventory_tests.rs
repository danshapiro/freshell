use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation, Registry},
    service::{default_backend, SupervisorConfig},
};
use freshell_runtime_protocol::{
    DockerDaemonId, HostBootId, IncarnationId, RecoveryBlockReason, RequestId, RuntimeLimits,
    RuntimeProfile, StopOutcome,
};
use std::path::Path;

async fn stopped_supervisor(root: &Path) -> (Supervisor, SoulId, IncarnationId) {
    let registry = Registry::open(root.join("registry"), None).unwrap();
    let soul = SoulId::new();
    let limits = RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    };
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "observer-store".into(),
            native_session_id: Some("ses_observer".into()),
            creation_seed_ref: "observer-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "observer-payload".into(),
            requested_limits: limits.clone(),
            profile: RuntimeProfile::Custom,
            project_key: "observer-project".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let host_binary = root.join("session-host");
    std::fs::write(&host_binary, b"test-only placeholder; never executed").unwrap();
    let image = format!("sha256:{}", "b".repeat(64));
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: image.clone(),
                runtime_dir: root.join("runtime"),
                host_binary_path: host_binary.clone(),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    registry
        .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits)
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();
    registry
        .mark_stop_outcome(prepared.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
        .await
        .unwrap();
    let supervisor = Supervisor::new(
        registry,
        // An absent private socket makes an attempted real backend probe
        // return PROVIDER_UNAVAILABLE; no Docker daemon or mock is needed.
        default_backend(root.join("absent-docker.sock")),
        SupervisorConfig {
            runtime_root: root.join("runtime"),
            control_socket_path: root.join("control.sock"),
            host_binary_path: host_binary,
            image_ref: image,
            test_run_id: "observer-test".into(),
            control_secret: "observer-test-secret".into(),
            lifecycle_log: root.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    (supervisor, soul, prepared.incarnation_id)
}

#[tokio::test]
async fn observer_retries_capability_pending_with_stopped_incarnation() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, soul, incarnation) = stopped_supervisor(root.path()).await;
    supervisor
        .registry
        .mark_recovery_blocked(
            soul.clone(),
            None,
            RecoveryBlockReason::CapabilityPending,
            vec![],
        )
        .await
        .unwrap();
    let before = supervisor.registry.inventory().await.unwrap();
    assert_eq!(before[0].desired_state, DesiredState::Running);
    assert_eq!(before[0].launch_state, LaunchState::Stopped);
    assert_eq!(
        before[0].recovery_reason.as_deref(),
        Some("CAPABILITY_PENDING")
    );

    supervisor.observe_once().await.unwrap();

    let after = supervisor.registry.inventory().await.unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].incarnation_id, incarnation);
    assert_eq!(after[0].native_session_id, before[0].native_session_id);
    assert_eq!(after[0].recovery_state, RecoveryState::Blocked);
    // The real recovery transaction reached its backend probe. Merely
    // admitting this row to the live-only handle lookup cannot do that.
    assert_eq!(
        after[0].recovery_reason.as_deref(),
        Some("PROVIDER_UNAVAILABLE")
    );
}

#[tokio::test]
async fn observer_leaves_manual_and_other_dependency_blocks_inert() {
    for reason in [
        RecoveryBlockReason::RetryBudget,
        RecoveryBlockReason::CredentialsExpired,
        RecoveryBlockReason::ProviderUnavailable,
        RecoveryBlockReason::StoreUnreadable,
    ] {
        let root = tempfile::tempdir().unwrap();
        let (supervisor, soul, _) = stopped_supervisor(root.path()).await;
        supervisor
            .registry
            .mark_recovery_blocked(soul, None, reason, vec![])
            .await
            .unwrap();
        let before = supervisor.registry.inventory().await.unwrap();

        supervisor.observe_once().await.unwrap();

        assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
        assert!(!supervisor.config.lifecycle_log.exists());
    }
}

#[tokio::test]
async fn observer_does_not_restart_explicitly_stopped_soul() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, soul, incarnation) = stopped_supervisor(root.path()).await;
    supervisor
        .registry
        .mark_recovery_blocked(
            soul.clone(),
            None,
            RecoveryBlockReason::CapabilityPending,
            vec![],
        )
        .await
        .unwrap();
    supervisor.registry.begin_stop(soul).await.unwrap();
    supervisor
        .registry
        .mark_stop_outcome(incarnation, StopOutcome::VerifiedEmpty)
        .await
        .unwrap();
    let before = supervisor.registry.inventory().await.unwrap();
    assert_eq!(before[0].desired_state, DesiredState::Stopped);

    supervisor.observe_once().await.unwrap();

    assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
    assert!(!supervisor.config.lifecycle_log.exists());
}

#[tokio::test]
async fn observer_leaves_lost_soul_inert() {
    let root = tempfile::tempdir().unwrap();
    let (supervisor, soul, _) = stopped_supervisor(root.path()).await;
    supervisor
        .registry
        .mark_recovery_lost(soul, None, "test_lost".into(), vec![])
        .await
        .unwrap();
    let before = supervisor.registry.inventory().await.unwrap();
    assert_eq!(before[0].recovery_state, RecoveryState::Lost);

    supervisor.observe_once().await.unwrap();

    assert_eq!(supervisor.registry.inventory().await.unwrap(), before);
    assert!(!supervisor.config.lifecycle_log.exists());
}
