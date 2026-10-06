use crate::{backend::*, registry::*, service::*};
use async_trait::async_trait;
use freshell_runtime_protocol::*;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

struct AuthBackend(AtomicUsize);
#[async_trait]
impl RuntimeBackend for AuthBackend {
    async fn read_native_auth(
        &self,
        handle: &OwnedRuntimeHandle,
        keys: &[String],
        _: &Path,
    ) -> Result<BTreeMap<String, String>, BackendError> {
        assert_eq!(
            handle.provider_volume_name(),
            stable_provider_volume_name(handle.installation_id(), handle.soul_id())
        );
        assert_eq!(keys, &["PATH_INPUT"]);
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(BTreeMap::from([(
            "PATH_INPUT".into(),
            "/synthetic/selected".into(),
        )]))
    }
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
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
async fn provider_native_auth_nested_callback_uses_current_attempt_without_relocking_soul() {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp.path().join("host");
    std::fs::write(&binary, "synthetic helper").unwrap();
    let registry = Registry::open(temp.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let limits = RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    };
    let launch = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "store".into(),
            native_session_id: None,
            creation_seed_ref: "explicit-test-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "digest".into(),
            requested_limits: limits,
            profile: RuntimeProfile::Custom,
            project_key: "workspace".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    registry
        .commit_created(
            launch.incarnation_id,
            BackendCreatedRecord {
                daemon_id: DockerDaemonId::new(),
                container_id: "owned-container".into(),
                image_ref: "sha256:synthetic-image".into(),
                runtime_dir: temp.path().into(),
                host_binary_path: binary.clone(),
                immutable_config_digest: "digest".into(),
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
    let backend = Arc::new(AuthBackend(AtomicUsize::new(0)));
    let secret = "synthetic-control-secret";
    let supervisor = Supervisor::new(
        registry,
        backend.clone(),
        SupervisorConfig {
            runtime_root: temp.path().join("runtime"),
            control_socket_path: temp.path().join("control.sock"),
            host_binary_path: binary,
            image_ref: "sha256:synthetic-image".into(),
            test_run_id: "auth-nested".into(),
            control_secret: secret.into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let lock = supervisor.lifecycle_lock(&soul).await;
    let _held = lock.lock().await;
    let scope = supervisor.auth_lookup_scope(&start);
    let key = scope.key.clone();
    let request = |soul: SoulId, key: String| {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::NativeAuthLookup(NativeAuthLookupRequest {
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
                soul_id: soul,
                attempt_authority: key,
                keys: vec!["PATH_INPUT".into()],
            }),
        );
        envelope.auth = Some(secret.into());
        envelope
    };
    let reply = tokio::time::timeout(
        std::time::Duration::from_millis(250),
        supervisor.dispatch(request(soul.clone(), key.clone())),
    )
    .await
    .expect("nested callback reacquired held soul lock");
    match reply.result.unwrap() {
        AdminResult::NativeAuthLookup(values) => {
            assert_eq!(values.0["PATH_INPUT"], "/synthetic/selected")
        }
        _ => panic!("unexpected auth reply"),
    }
    assert_eq!(backend.0.load(Ordering::SeqCst), 1);
    assert!(supervisor
        .dispatch(request(SoulId::new(), key.clone()))
        .await
        .result
        .is_err());
    assert!(supervisor
        .dispatch(request(soul.clone(), "foreign-authority".into()))
        .await
        .result
        .is_err());
    drop(scope);
    assert!(supervisor
        .dispatch(request(soul.clone(), key))
        .await
        .result
        .is_err());
    let scope = supervisor.auth_lookup_scope(&start);
    supervisor
        .registry
        .begin_stop_expected(soul.clone(), None)
        .await
        .unwrap();
    assert!(supervisor
        .dispatch(request(soul, scope.key.clone()))
        .await
        .result
        .is_err());
    assert_eq!(
        backend.0.load(Ordering::SeqCst),
        1,
        "expired/foreign/stopped attempt must never inspect auth"
    );
}
