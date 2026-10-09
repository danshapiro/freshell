//! Owning service/recovery tests. Synthetic daemon and authenticated host IPC
//! retain exact generation ownership across real registry/supervisor reopen.
use super::*;
use crate::backend::*;
use crate::registry::OwnedRuntimeHandle;
use async_trait::async_trait;
use freshell_runtime_protocol::*;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use tokio::net::UnixListener;

#[derive(Default)]
struct Daemon {
    generations: BTreeSet<String>,
    publishers: BTreeSet<String>,
    running: BTreeSet<IncarnationId>,
    events: Vec<String>,
    fail: Option<&'static str>,
    grants: usize,
    host_tasks: Vec<tokio::task::JoinHandle<()>>,
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
        state.generations.insert(inputs.generation_id.clone());
        state.publishers.insert(inputs.generation_id.clone());
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
        self.0.lock().unwrap().running.insert(id.clone());
        let state = self.0.clone();
        let task = tokio::spawn(async move {
            let boot = HostBootId::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                let result = match envelope.body {
                    HostCommand::Hello {
                        challenge,
                        incarnation_id,
                    } => HostResult::Hello {
                        host_boot_id: boot.clone(),
                        proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                        capabilities: vec![],
                        effective_limits: limits(),
                    },
                    HostCommand::GrantExecution { .. } => {
                        state.lock().unwrap().grants += 1;
                        HostResult::GrantAccepted {
                            host_boot_id: boot.clone(),
                            worker_pid: 1234,
                            worker_launch_count: 1,
                            fixture_evidence: serde_json::json!({}),
                            native_session_id: Some("ses_exact".into()),
                        }
                    }
                    HostCommand::Status { .. } => HostResult::Status {
                        host_boot_id: boot.clone(),
                        worker_pid: Some(1234),
                        worker_launch_count: 1,
                        max_control_epoch: 100,
                        max_execution_generation: 100,
                        fixture_evidence: serde_json::json!({}),
                        exited: false,
                        native_session_id: Some("ses_exact".into()),
                    },
                    HostCommand::ProbeRecovery {
                        resume_spec: Some(spec),
                        ..
                    } => HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                        evidence_revision: spec.evidence_revision,
                        resume_spec: spec,
                    }),
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
        Ok(BackendInspection {
            state: if self.0.lock().unwrap().running.contains(h.incarnation_id()) {
                BackendRuntimeState::Running
            } else {
                BackendRuntimeState::Exited
            },
            configured_limits: limits(),
        })
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        panic!("healthy retry must not stop a workload")
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("healthy retry must not stop a workload")
    }
    async fn verify_empty(&self, h: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
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
    let socket = path.clone();
    let task = tokio::spawn(async move { serve_control(owner, &socket).await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_accepted_completion_retries_after_registry_success_on_fresh_healthy_startup() {
    for failure in ["controller", "publisher", "retire"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("registry");
        let registry = Registry::open(&root, None).unwrap();
        let soul = SoulId::new();
        let daemon = Arc::new(Mutex::new(Daemon::default()));
        let callback = UnixListener::bind(temp.path().join("mcp.sock")).unwrap();
        let callback_daemon = daemon.clone();
        let callback_soul = soul.clone();
        let callback_task = tokio::spawn(async move {
            let mut next = 1;
            loop {
                let (mut socket, _) = callback.accept().await.unwrap();
                let mut raw = vec![];
                socket.read_to_end(&mut raw).await.unwrap();
                let request: serde_json::Value = serde_json::from_slice(&raw).unwrap();
                let response = if request["action"] == "issue" {
                    next += 1;
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
        let spec =
            freshell_agent_runtime::build_resume_spec(freshell_agent_runtime::ResumeSpecInput {
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
        daemon.lock().unwrap().fail = Some(failure);
        let request = || RecoverRequest {
            soul_id: soul.clone(),
            trigger: RecoveryTrigger::HostUnreachable,
            expected_intent_revision: None,
            expected_control_epoch: None,
        };
        let control = control_listener(&supervisor).await;
        let failed = control_recover(&supervisor.config.control_socket_path, request()).await;
        assert!(
            failed.is_err(),
            "injected post-success completion failure must reach actual recovery owner"
        );
        let live = registry.active_handle_for_soul(soul.clone()).await.unwrap();
        let view = registry
            .inventory()
            .await
            .unwrap()
            .into_iter()
            .find(|v| v.incarnation_id == *live.incarnation_id())
            .unwrap();
        assert_eq!(view.launch_state, LaunchState::Running);
        assert_eq!(view.recovery_state, RecoveryState::Live);
        assert_eq!(view.native_session_id.as_deref(), Some("ses_exact"));
        assert_eq!(daemon.lock().unwrap().generations.len(), 2);
        assert_eq!(daemon.lock().unwrap().grants, 2);
        control.abort();
        let _ = control.await;
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
        let startup = cold.reconcile_startup().await.unwrap();
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
}
