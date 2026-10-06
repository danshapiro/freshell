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

#[tokio::test]
async fn provider_initial_auth_requires_creation_reservation_before_absence_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp.path().join("synthetic-host");
    std::fs::write(&binary, "synthetic helper artifact").unwrap();
    let registry = Registry::open(temp.path().join("registry"), None).unwrap();
    let backend = Arc::new(AuthBackend(AtomicUsize::new(0)));
    let secret = "synthetic-control-secret";
    let supervisor = Supervisor::new(
        registry,
        backend.clone(),
        SupervisorConfig {
            runtime_root: temp.path().join("runtime"),
            control_socket_path: temp.path().join("control.sock"),
            host_binary_path: binary,
            image_ref: format!("sha256:{}", "a".repeat(64)),
            test_run_id: "initial-input-reservation".into(),
            control_secret: secret.into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let soul = SoulId::new();
    let command:AdminCommand=serde_json::from_value(serde_json::json!({
        "method":"reserve_provider_inputs","params":{
            "expectedControlEpoch":supervisor.registry.control_epoch(),"soulId":soul,
            "provider":"opencode","creationSeedRef":"synthetic-creation-seed"
        }
    })).expect("initial source selection needs a real reservation operation, not missing native identity as auth absence");
    let mut envelope = Envelope::new(RequestId::new(), ControlRole::Web, command);
    envelope.auth = Some(secret.into());
    let reply = supervisor.dispatch(envelope).await.result.unwrap();
    let receipt = serde_json::to_value(reply).unwrap();
    assert_eq!(receipt["kind"], "provider_input_reservation");
    assert_eq!(receipt["data"]["soulId"], soul.as_str());
    assert_eq!(receipt["data"]["intentRevision"], 1);
    assert_eq!(receipt["data"]["observation"]["kind"], "absent");
    assert_eq!(
        backend.0.load(Ordering::SeqCst),
        1,
        "daemon observation happens only after the registry reserves this creation"
    );
    assert!(
        supervisor.registry.inventory().await.unwrap().is_empty(),
        "input reservation must not invent a workload/container or native session identity"
    );
    let mut lookup = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::NativeAuthLookup(NativeAuthLookupRequest {
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
            soul_id: soul,
            attempt_authority: receipt["data"]["reservationId"].as_str().unwrap().into(),
            keys: vec!["PATH_INPUT".into()],
        }),
    );
    lookup.auth = Some(secret.into());
    match supervisor.dispatch(lookup).await.result.expect(
        "recorded initial absence must be available only through its current reserved source",
    ) {
        AdminResult::NativeAuthLookup(values) => assert!(values.0.is_empty()),
        _ => panic!("unexpected initial source reply"),
    }
    assert_eq!(
        backend.0.load(Ordering::SeqCst),
        2,
        "absence is reobserved rather than inferred from native identity"
    );
}
#[tokio::test]
async fn provider_frozen_path_binding_is_idempotent_private_and_generation_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp.path().join("synthetic-host");
    std::fs::write(&binary, "synthetic helper artifact").unwrap();
    let registry_root = temp.path().join("registry");
    let registry = Registry::open(&registry_root, None).unwrap();
    let secret = "synthetic-control-secret";
    let supervisor = Supervisor::new(
        registry,
        Arc::new(AuthBackend(AtomicUsize::new(0))),
        SupervisorConfig {
            runtime_root: temp.path().join("runtime"),
            control_socket_path: temp.path().join("control.sock"),
            host_binary_path: binary,
            image_ref: format!("sha256:{}", "a".repeat(64)),
            test_run_id: "private-path-binding".into(),
            control_secret: secret.into(),
            lifecycle_log: temp.path().join("lifecycle.jsonl"),
            admission: crate::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let soul = SoulId::new();
    let generation = format!("grant-{}", uuid::Uuid::new_v4());
    let sentinel = "PRIVATE_FROZEN_INPUT_SENTINEL";
    for (value, success) in [(sentinel, true), (sentinel, true), ("changed-input", false)] {
        let request = BindProviderPathInputsRequest {
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
            soul_id: soul.clone(),
            generation_id: generation.clone(),
            inputs: ProviderPathInputs::new(BTreeMap::from([("RULE_ROOT".into(), value.into())]))
                .unwrap(),
        };
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::BindProviderPathInputs(request),
        );
        envelope.auth = Some(secret.into());
        assert_eq!(supervisor.dispatch(envelope).await.result.is_ok(), success);
    }
    assert_eq!(
        supervisor
            .provider_path_inputs
            .lock()
            .unwrap()
            .get(&(soul.clone(), generation.clone()))
            .unwrap()
            .0
            .get("RULE_ROOT"),
        Some(sentinel)
    );
    assert!(supervisor.registry.inventory().await.unwrap().is_empty());
    supervisor.commit_provider_path_inputs(&soul, &generation);
    assert!(
        supervisor
            .provider_path_inputs
            .lock()
            .unwrap()
            .contains_key(&(soul.clone(), generation.clone())),
        "an accepted generation must retain process-only request path selections for replacement"
    );
    assert_eq!(
        supervisor
            .bound_provider_path_inputs(&soul, Some(&generation))
            .get("RULE_ROOT"),
        Some(sentinel)
    );
    assert!(
        supervisor
            .bound_provider_path_inputs(&SoulId::new(), Some(&generation))
            .is_empty(),
        "generation names never authorize another soul's selection"
    );

    for file in std::fs::read_dir(&registry_root).unwrap() {
        let file = file.unwrap().path();
        if file.is_file() {
            assert!(
                !std::fs::read(file)
                    .unwrap()
                    .windows(sentinel.len())
                    .any(|bytes| bytes == sentinel.as_bytes()),
                "private binding must not write an input snapshot to registry or its WAL"
            );
        }
    }
    let pending = format!("grant-{}", uuid::Uuid::new_v4());
    let excess = format!("grant-{}", uuid::Uuid::new_v4());
    for (candidate, success) in [(&pending, true), (&excess, false), (&pending, true)] {
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::BindProviderPathInputs(BindProviderPathInputsRequest {
                expected_control_epoch: Some(supervisor.registry.control_epoch()),
                soul_id: soul.clone(),
                generation_id: candidate.clone(),
                inputs: ProviderPathInputs::new(BTreeMap::from([(
                    "RULE_ROOT".into(),
                    sentinel.into(),
                )]))
                .unwrap(),
            }),
        );
        envelope.auth = Some(secret.into());
        assert_eq!(
            supervisor.dispatch(envelope).await.result.is_ok(),
            success,
            "a soul may retain only its active and one pending input generation"
        );
    }
    supervisor
        .provider_path_inputs
        .lock()
        .unwrap()
        .get_mut(&(soul.clone(), pending.clone()))
        .unwrap()
        .1 = Some(tokio::time::Instant::now() - std::time::Duration::from_secs(1));
    assert!(
        supervisor
            .bound_provider_path_inputs(&soul, Some(&pending))
            .is_empty(),
        "an expired unaccepted preparation cannot provide path inputs"
    );
    assert_eq!(
        supervisor
            .bound_provider_path_inputs(&soul, Some(&generation))
            .get("RULE_ROOT"),
        Some(sentinel),
        "the pending timeout must not remove the accepted selection"
    );
    let mut renewal = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::BindProviderPathInputs(BindProviderPathInputsRequest {
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
            soul_id: soul.clone(),
            generation_id: pending.clone(),
            inputs: ProviderPathInputs::new(BTreeMap::from([(
                "RULE_ROOT".into(),
                sentinel.into(),
            )]))
            .unwrap(),
        }),
    );
    renewal.auth = Some(secret.into());
    supervisor.dispatch(renewal).await.result.unwrap();
    supervisor.commit_provider_path_inputs(&soul, &pending);
    assert!(
        !supervisor
            .provider_path_inputs
            .lock()
            .unwrap()
            .contains_key(&(soul.clone(), generation.clone())),
        "accepting replacement must retire the previous process-only selection"
    );
    assert!(supervisor
        .provider_path_inputs
        .lock()
        .unwrap()
        .contains_key(&(soul.clone(), pending.clone())));
    let mut envelope = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::BindProviderPathInputs(BindProviderPathInputsRequest {
            expected_control_epoch: Some(supervisor.registry.control_epoch()),
            soul_id: soul.clone(),
            generation_id: pending.clone(),
            inputs: ProviderPathInputs::default(),
        }),
    );
    envelope.auth = Some(secret.into());
    supervisor.dispatch(envelope).await.result.unwrap();
    assert!(!supervisor
        .provider_path_inputs
        .lock()
        .unwrap()
        .contains_key(&(soul, pending)));
}

#[async_trait]
impl RuntimeBackend for AuthBackend {
    async fn observe_initial_auth_volume(
        &self,
        reservation: &OwnedInputReservation,
    ) -> Result<InitialAuthVolumeObservation, BackendError> {
        assert_eq!(
            reservation.provider_volume_name,
            stable_provider_volume_name(&reservation.installation_id, &reservation.soul_id)
        );
        self.0.fetch_add(1, Ordering::SeqCst);
        static DAEMON: std::sync::OnceLock<DockerDaemonId> = std::sync::OnceLock::new();
        Ok(InitialAuthVolumeObservation::Absent {
            daemon_id: DAEMON.get_or_init(DockerDaemonId::new).clone(),
        })
    }
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
    // Exercise the real callback and private control sockets while the same
    // soul's lifecycle lock is held. The nested lookup must use its scoped
    // attempt and the response must retain one complete generation/vector.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let control_task = tokio::spawn({
        let supervisor = supervisor.clone();
        let path = supervisor.config.control_socket_path.clone();
        async move { crate::service::serve_control(supervisor, &path).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !supervisor.config.control_socket_path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let callback_listener = tokio::net::UnixListener::bind(
        supervisor
            .config
            .control_socket_path
            .with_file_name("mcp.sock"),
    )
    .unwrap();
    let control_socket = supervisor.config.control_socket_path.clone();
    let epoch = supervisor.registry.control_epoch();
    let callback_soul = soul.clone();
    let generation = format!("grant-{}", uuid::Uuid::new_v4());
    let reference = McpCapabilityReference {
        grant_id: generation.clone(),
        endpoint: "http://host.docker.internal:4000".into(),
        provider_relative_path: ".freshell/mcp-capability.json".into(),
        host_gateway_address: None,
    };
    let context = ProviderLaunchContext {
        preparation: ProviderPreparation::Opencode {
            project_config: vec![],
            tui_config: None,
            tui_source: None,
            inline_config: false,
        },
        config: vec![],
        mcp_capability: Some(reference.clone()),
        prepared_inputs: None,
    };
    let mut reply_context = context.clone();
    reply_context.prepared_inputs = Some(PreparedProviderInputs {
        generation_id: generation.clone(),
        initial_auth_reservation: None,
        manifest: ProviderInputManifestReference {
            relative_path: ".freshell/input-manifest.json".into(),
            sha256: "a".repeat(64),
            source_count: 6,
            alias_count: 6,
            recipe_count: 0,
        },
        config_binds: vec![],
        resource_mounts: vec![],
        indexed_files: Some(IndexedProviderFiles {
            volume_name: indexed_provider_volume_name(&soul, &generation),
            aliases: (0..6)
                .map(|index| IndexedProviderFileAlias {
                    source_id: index,
                    logical_destination: format!("/fixture/source-{index}"),
                    effective_destination: format!("/fixture/source-{index}"),
                })
                .collect(),
        }),
    });
    let references = (0..6)
        .map(|index| ProviderSecretReference {
            source_path: format!("/private/source-{index}"),
            profile: ProviderSecretProfile::OpencodeConfigurationFile,
            provider_relative_path: Some(format!(".freshell/references/{index}")),
        })
        .collect::<Vec<_>>();
    let reply = PreparedProviderContext {
        provider_launch_context: reply_context,
        provider_secret_references: references.clone(),
    };
    let callback_task = tokio::spawn(async move {
        let (mut stream, _) = callback_listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        (&mut stream)
            .take((MAX_CONTROL_FRAME_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request["soulId"], callback_soul.as_str());
        assert_eq!(request["cwd"], "/fixture/instance");
        assert!(request["priorContext"].is_object());
        let mut control = tokio::net::UnixStream::connect(control_socket)
            .await
            .unwrap();
        let mut envelope = Envelope::new(
            RequestId::new(),
            ControlRole::Web,
            AdminCommand::NativeAuthLookup(NativeAuthLookupRequest {
                expected_control_epoch: Some(epoch),
                soul_id: callback_soul,
                attempt_authority: request["authLookupAuthority"].as_str().unwrap().into(),
                keys: vec!["PATH_INPUT".into()],
            }),
        );
        envelope.auth = Some(secret.into());
        write_frame(&mut control, &envelope).await.unwrap();
        let response: AdminReply = read_frame(&mut control).await.unwrap();
        let AdminResult::NativeAuthLookup(values) = response.result.unwrap() else {
            panic!("unexpected nested private RPC result")
        };
        assert_eq!(values.0["PATH_INPUT"], "/synthetic/selected");
        let bytes = bounded_json_bytes(&reply, MAX_CONTROL_FRAME_BYTES).unwrap();
        stream.write_all(&bytes).await.unwrap();
    });
    let returned = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        supervisor.issue_replacement_mcp_capability(
            &start,
            "opencode",
            &context,
            &[],
            "/fixture/instance",
            "/fixture/workspace",
        ),
    )
    .await
    .expect("complete callback lookup reacquired the held soul lock")
    .unwrap();
    assert_eq!(returned.provider_secret_references, references);
    assert_eq!(
        returned
            .provider_launch_context
            .prepared_inputs
            .unwrap()
            .generation_id,
        generation
    );
    callback_task.await.unwrap();
    control_task.abort();
    assert_eq!(backend.0.load(Ordering::SeqCst), 2);
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
        2,
        "expired/foreign/stopped attempt must never inspect auth"
    );
}
