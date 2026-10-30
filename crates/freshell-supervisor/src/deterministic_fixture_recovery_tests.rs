// Native bytes and the recovery controller stay real; only the enclosure and
// authenticated host socket are replaced. The declared fixture UID is the
// sandbox process's actual unprivileged UID, including every store read.
struct DeterministicNativeBackend {
    home: PathBuf,
    running: std::sync::atomic::AtomicBool,
    census_reads: std::sync::atomic::AtomicUsize,
    host_reads: std::sync::atomic::AtomicUsize,
    uid: u32,
    gid: u32,
}

impl DeterministicNativeBackend {
    fn read_store(
        &self,
        spec: &freshell_runtime_protocol::ResumeSpec,
        uid: u32,
        gid: u32,
    ) -> freshell_agent_runtime::ProviderStoreProbe {
        assert_eq!((uid, gid), (self.uid, self.gid));
        assert_eq!(unsafe { (libc::geteuid(), libc::getegid()) }, (uid, gid));
        assert_ne!(uid, 0, "native fixture reads must run unprivileged");
        assert_eq!(spec.provider_session.provider, "claude");
        freshell_agent_runtime::probe_provider_store(&self.home, spec)
    }
}

#[async_trait::async_trait]
impl RuntimeBackend for DeterministicNativeBackend {
    async fn read_native_census(
        &self,
        handle: &OwnedRuntimeHandle,
        spec: &freshell_runtime_protocol::ResumeSpec,
        _: &Path,
        _: &str,
    ) -> Result<freshell_agent_runtime::ProviderStoreProbe, BackendError> {
        assert_eq!(
            spec.provider_session.provider_store_id,
            handle.provider_store_id()
        );
        assert_eq!(
            spec.provider_volume.as_ref().unwrap().volume_name,
            handle.provider_volume_name()
        );
        let agent = handle.fresh_agent().unwrap();
        self.census_reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.read_store(spec, agent.run_as_uid, agent.run_as_gid))
    }
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        Ok(BackendInspection {
            state: if self.running.load(Ordering::SeqCst) {
                BackendRuntimeState::Running
            } else {
                BackendRuntimeState::Exited
            },
            configured_limits: handle.requested_limits(),
        })
    }
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        unreachable!("classification must not create a runtime")
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("classification must not start a provider")
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        unreachable!("classification must not stop a provider")
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("classification must not kill a provider")
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(!self.running.load(Ordering::SeqCst))
    }
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        let mut result = Vec::new();
        for handle in handles {
            result.push((handle.incarnation_id().clone(), self.inspect(handle).await?));
        }
        Ok(result)
    }
    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        Ok(handle.requested_limits())
    }
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        unreachable!("classification must not change limits")
    }
}

struct DeterministicNativeRecovery {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    backend: Arc<DeterministicNativeBackend>,
    soul: SoulId,
    native: String,
    transcript: PathBuf,
    host: tokio::task::JoinHandle<()>,
}

impl Drop for DeterministicNativeRecovery {
    fn drop(&mut self) {
        self.host.abort();
    }
}

impl DeterministicNativeRecovery {
    async fn new(running: bool) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::Builder::new()
            .prefix("native-fixture-")
            .tempdir()
            .unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        assert_ne!(uid, 0, "run native fixture tests in the supported sandbox");
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
                .await;
        let initial = registry.recovery_context(soul.clone()).await.unwrap();
        let native = uuid::Uuid::new_v4().to_string();
        let mut agent = initial.fresh_agent.unwrap();
        agent.fixture_transport =
            Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic);
        agent.run_as_uid = uid;
        agent.run_as_gid = gid;
        agent.native_session_id = Some(native.clone());
        let runtime = root.path().join("rt");
        std::fs::create_dir(&runtime).unwrap();
        Connection::open(registry.database_path()).unwrap().execute(
            "UPDATE incarnations SET fresh_agent_spec=?1,runtime_dir=?2,host_binary_path=?3,image_ref=?4 WHERE incarnation_id=?5",
            rusqlite::params![serde_json::to_string(&agent).unwrap(),runtime.to_string_lossy(),std::env::current_exe().unwrap().to_string_lossy(),format!("sha256:{}", "a".repeat(64)),prepared.incarnation_id.as_str()],
        ).unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                native.clone(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
                evidence_revision: context.evidence_revision,
                execution_generation: 0,
                requested_native_session_id: Some(native.clone()),
            })
            .await
            .unwrap();
        let home = root.path().join("provider");
        let transcript = home
            .join(".claude/projects/managed-fixture")
            .join(format!("{native}.jsonl"));
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        // Same native schema as the named deterministic transport. The real
        // semantic reader, rather than counters or a canned Ready, qualifies it.
        let rows = [
            serde_json::json!({"type":"system","subtype":"init","sessionId":native,"cwd":root.path()}),
            serde_json::json!({"type":"user","uuid":"user-fixture","sessionId":native,"cwd":"/workspace","message":{"role":"user","content":"owned fixture input"}}),
            serde_json::json!({"type":"assistant","uuid":"assistant-fixture","parentUuid":"user-fixture","sessionId":native,"message":{"role":"assistant","content":[{"type":"text","text":"owned fixture answer"}]}}),
        ];
        std::fs::write(
            &transcript,
            rows.iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o600)).unwrap();
        let backend = Arc::new(DeterministicNativeBackend {
            home,
            running: std::sync::atomic::AtomicBool::new(running),
            census_reads: std::sync::atomic::AtomicUsize::new(0),
            host_reads: std::sync::atomic::AtomicUsize::new(0),
            uid,
            gid,
        });
        let supervisor = Supervisor::new(
            registry,
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.path().join("runtime"),
                control_socket_path: root.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "deterministic-native-store".into(),
                control_secret: "owned-fixture-control".into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let context = supervisor
            .registry
            .recovery_context(soul.clone())
            .await
            .unwrap();
        let limits = context.prior_handle.requested_limits();
        let incarnation = prepared.incarnation_id;
        let secret = b"owned-native-fixture-host";
        std::fs::write(runtime.join("secret"), secret).unwrap();
        let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
        let (reader, actual_native) = (backend.clone(), native.clone());
        let host = tokio::spawn(async move {
            let boot = HostBootId::new();
            while let Ok((mut socket, _)) = listener.accept().await {
                let request: Envelope<freshell_runtime_protocol::HostCommand> =
                    read_frame(&mut socket).await.unwrap();
                let result = match request.body {
                    freshell_runtime_protocol::HostCommand::Hello {
                        incarnation_id,
                        challenge,
                    } => {
                        assert_eq!(incarnation_id, incarnation);
                        freshell_runtime_protocol::HostResult::Hello {
                            proof: host_proof(secret, &challenge, &boot, &incarnation_id),
                            host_boot_id: boot.clone(),
                            capabilities: vec![
                                "native-identity-observation-v1".into(),
                                "provider-store-probe-v1".into(),
                                "owned-provider-config-v1".into(),
                            ],
                            effective_limits: limits,
                        }
                    }
                    freshell_runtime_protocol::HostCommand::Status { .. } => {
                        freshell_runtime_protocol::HostResult::Status {
                            host_boot_id: boot.clone(),
                            worker_pid: Some(42),
                            worker_launch_count: 1,
                            max_control_epoch: 1,
                            max_execution_generation: 0,
                            fixture_evidence: serde_json::json!({"fixtureTransport":"deterministic"}),
                            exited: false,
                            native_session_id: Some(actual_native.clone()),
                            native_identity_observation: None,
                            opencode_transfer_receipt: None,
                            opencode_adoption: Default::default(),
                        }
                    }
                    freshell_runtime_protocol::HostCommand::ProbeRecovery {
                        resume_spec,
                        run_as_uid,
                        run_as_gid,
                        ..
                    } => {
                        reader.host_reads.fetch_add(1, Ordering::SeqCst);
                        let candidate =
                            *resume_spec.expect("the actual catalog supplies an exact candidate");
                        let probe = match reader.read_store(&candidate, run_as_uid, run_as_gid) {
                            freshell_agent_runtime::ProviderStoreProbe::Ready { .. } => {
                                RecoveryProbe::ResumeReady {
                                    evidence_revision: candidate.evidence_revision,
                                    resume_spec: Box::new(candidate),
                                }
                            }
                            _ => freshell_agent_runtime::unverified_native_probe(),
                        };
                        freshell_runtime_protocol::HostResult::RecoveryProbe(probe)
                    }
                    other => panic!("native capture must not dispatch effects: {other:?}"),
                };
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
        });
        Self {
            _root: root,
            supervisor,
            backend,
            soul,
            native,
            transcript,
            host,
        }
    }
}

#[tokio::test]
async fn deterministic_native_fixture_live_capture_preserves_actual_store_evidence() {
    let fixture = DeterministicNativeRecovery::new(true).await;
    assert!(fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .resume_spec
        .is_none());
    let (probe, _, _) = fixture
        .supervisor
        .classify_recovery(fixture.soul.clone())
        .await
        .unwrap();
    assert!(
        matches!(probe, RecoveryProbe::ReattachReady { .. }),
        "{probe:?}"
    );
    assert_eq!(
        fixture.backend.host_reads.load(Ordering::SeqCst),
        1,
        "live capture must request the host's checked store evidence"
    );
    let saved = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .resume_spec
        .expect("actual readable native bytes must leave durable resume evidence");
    assert_eq!(saved.provider_session.native_session_id, fixture.native);
    fixture.backend.running.store(false, Ordering::SeqCst);
    let (probe, context, _) = fixture
        .supervisor
        .classify_recovery(fixture.soul.clone())
        .await
        .unwrap();
    assert!(
        matches!(probe, RecoveryProbe::ResumeReady { .. }),
        "{probe:?}"
    );
    assert_eq!(context.resume_spec.unwrap(), saved);
    assert_eq!(
        fixture.backend.census_reads.load(Ordering::SeqCst),
        0,
        "a captured exact recipe remains available after host exit"
    );
}

#[tokio::test]
async fn deterministic_native_fixture_stopped_census_requires_actual_readable_history() {
    use std::os::unix::fs::PermissionsExt;
    for case in ["readable", "different-root", "invalid-json", "unreadable"] {
        let fixture = DeterministicNativeRecovery::new(false).await;
        match case {
            "different-root" => {
                let other = uuid::Uuid::new_v4().to_string();
                let rows = std::fs::read_to_string(&fixture.transcript)
                    .unwrap()
                    .lines()
                    .map(|line| {
                        let mut row: serde_json::Value = serde_json::from_str(line).unwrap();
                        row["sessionId"] = serde_json::json!(other);
                        format!("{row}\n")
                    })
                    .collect::<String>();
                std::fs::write(&fixture.transcript, rows).unwrap();
            }
            "invalid-json" => {
                std::fs::write(&fixture.transcript, b"{invalid native JSON\n").unwrap()
            }
            "unreadable" => {
                std::fs::set_permissions(&fixture.transcript, std::fs::Permissions::from_mode(0o0))
                    .unwrap()
            }
            _ => {}
        }
        assert!(fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .resume_spec
            .is_none());
        let (probe, context, _) = fixture
            .supervisor
            .classify_recovery(fixture.soul.clone())
            .await
            .unwrap();
        assert_eq!(
            fixture.backend.census_reads.load(Ordering::SeqCst),
            1,
            "{case}: stopped fixture must use actual native census"
        );
        if case == "readable" {
            assert!(
                matches!(probe, RecoveryProbe::ResumeReady { .. }),
                "{case}: {probe:?}"
            );
            let saved = context
                .resume_spec
                .expect("verified census must persist exact resume evidence");
            assert_eq!(saved.provider_session.native_session_id, fixture.native);
        } else {
            assert!(
                matches!(
                    probe,
                    RecoveryProbe::Blocked {
                        reason: RecoveryBlockReason::StoreUnreadable,
                        ..
                    }
                ),
                "{case}: {probe:?}"
            );
            assert!(
                context.resume_spec.is_none(),
                "{case}: bad native bytes cannot acquire durable resume authority"
            );
        }
        assert_eq!(
            fixture.backend.host_reads.load(Ordering::SeqCst),
            0,
            "stopped census never starts or contacts the provider"
        );
    }
}
