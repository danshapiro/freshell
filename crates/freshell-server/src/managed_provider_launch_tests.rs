//! Closed synthetic native startup qualification. The external sandbox owns
//! the broker, pinned image, shared scratch and every process/container cleanup.
use async_trait::async_trait;
use freshell_runtime_protocol::*;
use freshell_supervisor::{
    backend::{
        BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, DockerEngineBackend,
        RuntimeBackend,
    },
    registry::{OwnedInputReservation, OwnedRuntimeHandle},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

// Read only the fixture's actual native process (or its bounded hook ancestry).
// argv/environment bytes stay transient; only profile compliance is reported.
const NATIVE_EXEC_PROFILE: &str = r#"
function nativeExecProfile(target) {
 let operation='select_native_process';
 const ancestry=[];
 try {
 let pid=target==='self'?process.pid:process.ppid;
 if(target==='claude') {
  let found=false;
  for(let depth=0;depth<16&&pid>1;depth++) {
   const executable=fs.readlinkSync('/proc/'+pid+'/exe').split('/').pop();
   const comm=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();
   ancestry.push({executable:executable==='claude'?'claude':executable.includes('claude')?'claude_variant':['node','bash','sh','timeout','freshell-session-host'].includes(executable)?executable:'other',comm:comm==='claude'?'claude':comm.includes('claude')?'claude_variant':['node','bash','sh','timeout','freshell-sessio'].includes(comm)?comm:'other'});
   if(comm==='claude'&&executable.includes('claude')) {found=true;break;}
   const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
   pid=Number(status.match(/^PPid:\s+(\d+)/m)[1]);
  }
  if(!found)throw Error('closed native hook ancestry unavailable');
 }
 const prefix='/proc/'+pid+'/';
 operation='read_native_argv'; const argv=fs.readFileSync(prefix+'cmdline');
 operation='read_native_environment'; const env=fs.readFileSync(prefix+'environ');
 const strings=[...argv.toString().split('\0').filter(Boolean),...env.toString().split('\0').filter(Boolean)];
 operation='read_native_stack'; const stack=fs.readFileSync(prefix+'limits','utf8').match(/^Max stack size\s+(\S+)/m)[1];
 const result={stackAtLeast8MiB:stack==='unlimited'||Number(stack)>=8388608,aggregateWithin1MiB:argv.length+env.length+8*(strings.length+2)+Buffer.byteLength(fs.readlinkSync(prefix+'exe'))+1<=1048576,completeStringsWithin32Pages:strings.every(value=>Buffer.byteLength(value)+1<=131072)};
 if(Object.values(result).some(value=>!value))throw Error('closed final native execution profile exceeded');
 return result;
 } catch(error) {
  if(target==='claude')fs.writeFileSync(process.argv[2]+'.profile-failure.json',JSON.stringify({operation,code:['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:error.message==='closed native hook ancestry unavailable'?'NATIVE_NOT_FOUND':error instanceof TypeError?'TYPE_ERROR':'unclassified',ancestry}));
  throw Error('closed native profile observation failed');
 }
}
"#;

fn native_exec_profile() -> Value {
    json!({"stackAtLeast8MiB":true,"aggregateWithin1MiB":true,"completeStringsWithin32Pages":true})
}

fn assert_private_sentinels_absent(root: &Path, certificate_sentinel: &[u8]) {
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let metadata = entry.file_type().unwrap_or_else(|error| {
            panic!(
                "owned privacy scan metadata {}: {error}",
                entry.path().display()
            )
        });
        if metadata.is_dir() {
            assert_private_sentinels_absent(&entry.path(), certificate_sentinel);
        } else if metadata.is_file() {
            let bytes = std::fs::read(entry.path()).unwrap();
            for (ordinal, sentinel) in [
                certificate_sentinel,
                b"AUTH_PREFIX".as_slice(),
                b"native-rule".as_slice(),
                b"native-explicit-selected-rule".as_slice(),
                b"native-inline-selected-rule".as_slice(),
                b"native-shared-root-rule".as_slice(),
                b"native-shared-nested-rule".as_slice(),
                b"shared-home-private-rule".as_slice(),
                b"shared-home-sensitive-file".as_slice(),
                b"INLINE_PREFIX".as_slice(),
                b"AUTH_INLINE_SHADOW_NO_FILE".as_slice(),
                b"synthetic-onecli-shadowed".as_slice(),
            ]
            .into_iter()
            .enumerate()
            {
                assert!(
                    !bytes.windows(sentinel.len()).any(|value| value == sentinel),
                    "private input sentinel {ordinal} leaked to owned surface {}",
                    entry.path().display()
                );
            }
        }
    }
}

/// Delegates every lifecycle operation to the actual Docker backend. The only
/// added operation delivers metadata to the closed fixture's trusted broker.
struct BrokerAuthorizedBackend {
    real: DockerEngineBackend,
    cold_backend: std::sync::OnceLock<DockerEngineBackend>,
    control: PathBuf,
    handoff: PathBuf,
    certificate_sentinel: Vec<u8>,
}
impl BrokerAuthorizedBackend {
    fn real(&self) -> &DockerEngineBackend {
        self.cold_backend.get().unwrap_or(&self.real)
    }
    async fn authorize_claude_candidate(
        &self,
        owner: &freshell_supervisor::backend::ClaudeSourceOwner,
        request: &ObserveClaudeSourcesRequest,
    ) -> Result<(), BackendError> {
        use std::io::Read;
        let Some(candidate) = request.candidate.as_ref() else {
            return Ok(());
        };
        let invalid =
            || BackendError::InvalidConfig("closed Claude candidate handoff invalid".into());
        request.validate().map_err(|_| invalid())?;
        let inputs = candidate
            .provider_launch_context
            .prepared_inputs
            .as_ref()
            .ok_or_else(invalid)?;
        let binding = request
            .observation_request
            .candidate_binding
            .as_ref()
            .ok_or_else(invalid)?;
        if binding.soul_id != request.soul_id.as_str()
            || binding.generation_id != inputs.generation_id
            || inputs.indexed_files.is_some()
            || inputs.manifest.source_count != 0
            || inputs.manifest.alias_count != 0
            || inputs.manifest.recipe_count != 0
        {
            return Err(invalid());
        }
        let (daemon_id, reservation_id, retained) = match owner {
            freshell_supervisor::backend::ClaudeSourceOwner::Initial { observation, .. } => {
                let InitialAuthVolumeObservation::Absent { daemon_id } = observation else {
                    return Err(invalid());
                };
                let ClaudeSourceAuthority::InitialReservation { reservation_id } =
                    &request.authority
                else {
                    return Err(invalid());
                };
                if inputs.initial_auth_reservation.as_deref() != Some(reservation_id.as_str()) {
                    return Err(invalid());
                }
                (daemon_id, reservation_id.clone(), None)
            }
            freshell_supervisor::backend::ClaudeSourceOwner::Retained {
                handle,
                recovery_source,
            } => {
                let source = recovery_source.as_ref().ok_or_else(invalid)?;
                source.validate().map_err(|_| invalid())?;
                if !matches!(
                    request.authority,
                    ClaudeSourceAuthority::RecoveryAttempt { .. }
                ) || handle.soul_id() != &request.soul_id
                    || inputs.initial_auth_reservation.is_some()
                {
                    return Err(invalid());
                }
                let prior = handle
                    .terminal()
                    .and_then(|spec| spec.provider_launch_context.as_ref())
                    .or_else(|| {
                        handle
                            .fresh_agent()
                            .and_then(|spec| spec.provider_launch_context.as_ref())
                    })
                    .and_then(|context| context.prepared_inputs.as_ref())
                    .ok_or_else(invalid)?;
                if prior.generation_id != source.prior_generation_id
                    || prior.generation_id == inputs.generation_id
                {
                    return Err(invalid());
                }
                // Original creation metadata is carried only by this closed
                // fixture. The real authority remains its registry recovery
                // attempt and private callback scope, never a new reservation.
                let reservation = prior.initial_auth_reservation.clone().ok_or_else(invalid)?;
                let retained = json!({"attemptId":source.registry_attempt_id,"generationId":prior.generation_id,
                    "stageRoot":self.control.join("provider-roots").join(&prior.generation_id),
                    "configurationBinds":prior.config_binds.iter().map(|bind|json!({"sourceRelativePath":bind.source_relative_path,"effectiveDestination":bind.effective_destination})).collect::<Vec<_>>(),
                    "resourceMounts":prior.resource_mounts.iter().map(|mount|json!({"stageRelativePath":mount.stage_relative_path,"providerRelativePath":mount.provider_relative_path,"effectiveDestination":mount.effective_destination,"kind":mount.kind})).collect::<Vec<_>>()});
                (handle.daemon_id(), reservation, Some(retained))
            }
        };
        let root = self.handoff.parent().ok_or_else(invalid)?;
        // The wrapper's closed source configuration contains only artifact and
        // owner metadata. Bound the physical file before allocating its frame.
        let mut file =
            std::fs::File::open(root.join("broker-configuration.json")).map_err(|_| invalid())?;
        let length = file.metadata().map_err(|_| invalid())?.len();
        if length > MAX_CONTROL_FRAME_BYTES as u64 {
            return Err(invalid());
        }
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes).map_err(|_| invalid())?;
        let mut growth = [0; 1];
        if file.read(&mut growth).map_err(|_| invalid())? != 0 {
            return Err(invalid());
        }
        let configuration: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let sources = configuration["initialVolumes"]
            .as_array()
            .ok_or_else(invalid)?;
        let mut matching = sources
            .iter()
            .filter(|source| source["soulId"] == request.soul_id.as_str());
        let source = matching.next().ok_or_else(invalid)?;
        if matching.next().is_some() || source["daemonId"] != daemon_id.as_str() {
            return Err(invalid());
        }
        let value = json!({
            "installationId":source["installationId"],"soulId":request.soul_id,
            "providerVolumeName":source["providerVolumeName"],"imageRef":source["imageRef"],
            "hostBinaryPath":source["hostBinaryPath"],"binarySha256":source["binarySha256"],"daemonId":source["daemonId"],
            "reservationId":reservation_id,"requestId":request.observation_request.request_id,"generationId":inputs.generation_id,
            "stageRoot":self.control.join("provider-roots").join(&inputs.generation_id),
            "workspacePath":request.workspace_path,"cwd":request.observation_request.cwd,
            "manifestRelativePath":inputs.manifest.relative_path,
            "configurationBinds":inputs.config_binds.iter().map(|bind|json!({"sourceRelativePath":bind.source_relative_path,"effectiveDestination":bind.effective_destination})).collect::<Vec<_>>(),
            "resourceMounts":inputs.resource_mounts.iter().map(|mount|json!({"stageRelativePath":mount.stage_relative_path,"providerRelativePath":mount.provider_relative_path,"effectiveDestination":mount.effective_destination,"kind":mount.kind})).collect::<Vec<_>>(),
        });
        let mut value = value;
        if let Some(retained) = retained {
            value["retained"] = retained;
        }
        if let Some(common) = &request.git_common_dir {
            value["gitCommonDir"] = json!(common);
        }
        let metadata =
            bounded_json_bytes(&value, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        let path = root
            .join("candidate-handoff")
            .join(format!("{}.json", request.observation_request.request_id));
        let temporary = path.with_extension("pending");
        std::fs::write(&temporary, metadata).map_err(|_| invalid())?;
        std::fs::rename(&temporary, &path).map_err(|_| invalid())?;
        assert_private_sentinels_absent(
            &root.join("candidate-handoff"),
            &self.certificate_sentinel,
        );
        tokio::time::timeout(Duration::from_secs(10), async {
            while !path.with_extension("accepted").is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            BackendError::Unavailable(
                "closed Claude candidate broker authorization timed out".into(),
            )
        })?;
        Ok(())
    }

    async fn authorize(&self, spec: &CreateRuntimeSpec) -> Result<(), BackendError> {
        let invalid =
            || BackendError::InvalidConfig("closed native fixture metadata handoff invalid".into());
        let (context, references) = spec
            .terminal
            .as_ref()
            .map(|workload| {
                (
                    &workload.provider_launch_context,
                    &workload.provider_secret_references,
                )
            })
            .or_else(|| {
                spec.fresh_agent.as_ref().map(|workload| {
                    (
                        &workload.provider_launch_context,
                        &workload.provider_secret_references,
                    )
                })
            })
            .ok_or_else(invalid)?;
        let context = context.as_ref().ok_or_else(invalid)?;
        let inputs = context.prepared_inputs.as_ref().ok_or_else(invalid)?;
        inputs
            .validate_references(references)
            .map_err(|_| invalid())?;
        assert_private_sentinels_absent(
            &self
                .control
                .join("provider-roots")
                .join(&inputs.generation_id),
            &self.certificate_sentinel,
        );
        let indexed = references
            .iter()
            .enumerate()
            .filter(|(_, reference)| reference.profile.is_configuration_file())
            .map(|(index, reference)| {
                let source = reference
                    .provider_relative_path
                    .as_deref()
                    .and_then(|path| path.strip_prefix(".freshell/references/"))
                    .and_then(|id| id.parse::<u16>().ok())
                    .ok_or_else(invalid)?;
                Ok(json!({"grantIndex":index,"sourceId":source}))
            })
            .collect::<Result<Vec<_>, BackendError>>()?;
        let value = json!({
            "installationId":spec.installation_id,"soulId":spec.soul_id,"incarnationId":spec.incarnation_id,
            "imageRef":spec.image_ref,"hostBinaryPath":spec.host_binary_path,"providerVolumeName":spec.provider_volume_name,
            "stageRoot":self.control.join("provider-roots").join(&inputs.generation_id),"generationId":inputs.generation_id,
            "initialAuthReservation":inputs.initial_auth_reservation,
            "configurationBinds":inputs.config_binds.iter().map(|bind|json!({"sourceRelativePath":bind.source_relative_path,"effectiveDestination":bind.effective_destination})).collect::<Vec<_>>(),
            "resourceMounts":inputs.resource_mounts.iter().map(|mount|json!({"providerRelativePath":mount.provider_relative_path,"effectiveDestination":mount.effective_destination,"kind":mount.kind})).collect::<Vec<_>>(),
            "indexedFiles":inputs.indexed_files.as_ref().map(|files|json!({"volumeName":files.volume_name,"aliases":files.aliases.iter().map(|alias|json!({"sourceId":alias.source_id,"effectiveDestination":alias.effective_destination})).collect::<Vec<_>>()})),
            "indexedSecretSources":indexed,
        });
        let metadata =
            bounded_json_bytes(&value, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        let path = self.handoff.join(format!("{}.json", spec.incarnation_id));
        let temporary = path.with_extension("pending");
        std::fs::write(&temporary, metadata).map_err(|_| invalid())?;
        std::fs::rename(&temporary, &path).map_err(|_| invalid())?;
        let receipt = path.with_extension("accepted");
        tokio::time::timeout(Duration::from_secs(10), async {
            while !receipt.is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            BackendError::Unavailable("closed native fixture broker authorization timed out".into())
        })?;
        Ok(())
    }
}
#[async_trait]
impl RuntimeBackend for BrokerAuthorizedBackend {
    async fn observe_claude_sources(
        &self,
        owner: &freshell_supervisor::backend::ClaudeSourceOwner,
        request: &ObserveClaudeSourcesRequest,
        test_run_id: &str,
    ) -> Result<freshell_platform::claude_inputs::observation::ObservationReply, BackendError> {
        self.authorize_claude_candidate(owner, request).await?;
        let reply = match self
            .real()
            .observe_claude_sources(owner, request, test_run_id)
            .await
        {
            Ok(reply) => reply,
            Err(error) => {
                let message = error.to_string();
                let classes = [
                    "private",
                    "peer",
                    "identity",
                    "reply",
                    "digest",
                    "retained",
                    "frozen",
                    "manifest",
                    "metadata",
                    "topology",
                    "mount",
                    "report",
                    "actual",
                    "changed",
                    "timeout",
                    "unavailable",
                    "cleanup",
                    "ownership",
                    "baseline",
                    "candidate",
                ]
                .into_iter()
                .filter(|class| message.contains(class))
                .collect::<Vec<_>>();
                println!(
                    "provider_source_reader_failure {}",
                    json!({"candidate":request.candidate.is_some(),"classes":classes,"messageBytes":message.len()})
                );
                return Err(error);
            }
        };
        if let Some(binding) = &request.observation_request.candidate_binding {
            println!(
                "provider_candidate_observer {}",
                json!({
                    "requestId":request.observation_request.request_id,"generationId":binding.generation_id,
                    "soulId":request.soul_id,"planRevision":request.observation_request.plan_revision,
                    "runtime":request.observation_request.native_source_runtime,"uid":reply.observation.uid,
                    "gid":reply.observation.gid,"supplementaryGroups":reply.observation.supplementary_groups,
                    "backendCompleteAfterCleanup":true,
                })
            );
        } else if matches!(
            owner,
            freshell_supervisor::backend::ClaudeSourceOwner::Retained { .. }
        ) {
            println!(
                "provider_retained_source_observer {}",
                json!({"uid":reply.observation.uid,"gid":reply.observation.gid,"supplementaryGroups":reply.observation.supplementary_groups,"rootUid":reply.observation.root_uid,"decision":reply.observation.local_decision,"localCount":reply.observation.local_settings.len(),"backendCompleteAfterCleanup":true})
            );
        }
        Ok(reply)
    }
    async fn observe_initial_auth_volume(
        &self,
        reservation: &OwnedInputReservation,
    ) -> Result<InitialAuthVolumeObservation, BackendError> {
        self.real().observe_initial_auth_volume(reservation).await
    }
    async fn discard_rejected_provider_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        self.real().discard_rejected_provider_inputs(handle).await
    }
    async fn commit_prepared_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        if handle.terminal().is_some_and(|v| v.mode == "opencode") {
            // The accepted workload now holds the tmpfs. A second fresh
            // constructor releases the exact old publisher without its map.
            let cold = DockerEngineBackend::new(self.handoff.parent().unwrap().join("broker.sock"));
            cold.commit_prepared_inputs(handle).await?;
            println!(
                "provider_indexed_cold_lifecycle {}",
                json!({"phase":"accepted-release","freshConstructor":true,"workloadVolumePreserved":true})
            );
        }
        self.real().commit_prepared_inputs(handle).await
    }
    async fn retire_prior_prepared_inputs(
        &self,
        current: &OwnedRuntimeHandle,
        prior: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        self.real()
            .retire_prior_prepared_inputs(current, prior)
            .await
    }
    async fn read_native_auth(
        &self,
        handle: &OwnedRuntimeHandle,
        keys: &[String],
        binary: &Path,
    ) -> Result<BTreeMap<String, String>, BackendError> {
        self.real().read_native_auth(handle, keys, binary).await
    }
    async fn read_native_history(
        &self,
        handle: &OwnedRuntimeHandle,
        provider: &str,
        id: &str,
        binary: &Path,
    ) -> Result<Value, BackendError> {
        self.real()
            .read_native_history(handle, provider, id, binary)
            .await
    }
    async fn create_stopped(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<BackendCreated, BackendError> {
        self.authorize(spec).await?;
        if spec.terminal.as_ref().is_some_and(|v| v.mode == "opencode")
            && self.cold_backend.get().is_none()
        {
            // The finite broker fails BEFORE forwarding main create, after the
            // real publisher seals its tmpfs. Drop every old backend reference
            // then construct a fresh production backend, not a cloned map.
            let old = DockerEngineBackend::new(self.handoff.parent().unwrap().join("broker.sock"));
            let failed = old.create_stopped(spec).await;
            assert!(matches!(failed,Err(BackendError::DockerHttp{status:503,..})),"closed cold-boundary failure must occur after actual publication and before workload create");
            drop(old);
            assert!(self
                .cold_backend
                .set(DockerEngineBackend::new(
                    self.handoff.parent().unwrap().join("broker.sock")
                ))
                .is_ok());
            println!(
                "provider_indexed_cold_lifecycle {}",
                json!({"phase":"population-before-create","freshConstructor":true,"oldBackendDropped":true,"noWorkloadDispatch":true})
            );
        }
        let created = self.real().create_stopped(spec).await?;
        if std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_SOURCE_GUARD").as_deref()
            == Ok("changed-git")
        {
            let (route, cwd) = if let Some(terminal) = &spec.terminal {
                ("terminal", terminal.cwd.as_str())
            } else {
                ("fresh", spec.fresh_agent.as_ref().unwrap().cwd.as_str())
            };
            // Native discovery recognizes the closest filesystem Git marker.
            // Introduce a closer root only after accepted-source observation
            // and mount validation. All original files and declared workspace
            // and common-directory mount paths remain untouched.
            std::fs::create_dir(Path::new(cwd).join(".git")).unwrap();
            std::fs::write(
                self.handoff.join(format!("source-guard-{route}.state")),
                spec.runtime_dir.to_str().unwrap(),
            )
            .unwrap();
        }
        Ok(created)
    }
    async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real().start_host(handle).await
    }
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        self.real().inspect(handle).await
    }
    async fn request_stop(
        &self,
        handle: &OwnedRuntimeHandle,
        grace: u64,
    ) -> Result<(), BackendError> {
        self.real().request_stop(handle, grace).await
    }
    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real().force_stop(handle).await
    }
    async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        self.real().verify_empty(handle).await
    }
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        self.real().list_known(handles).await
    }
    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        self.real().read_limits(handle).await
    }
    async fn enable_long_lived(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real().enable_long_lived(handle).await
    }
}

fn capture_fresh_launch_failure_classes() -> std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> {
    use tracing_subscriber::prelude::*;
    #[derive(Clone)]
    struct FailureLayer(std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for FailureLayer {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if !event.metadata().target().contains("fresh_agent_proxy")
                && !event.metadata().target().contains("managed_mcp_capability")
            {
                return;
            }
            struct Classes(Vec<&'static str>);
            impl tracing::field::Visit for Classes {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() != "error" {
                        return;
                    }
                    let text = format!("{value:?}");
                    for label in [
                        "Claude native source selection changed",
                        "HostUnreachable",
                        "InvalidRequest",
                        "ProviderInputsChanged",
                        "prepare hosted provider config",
                        "prepare hosted fresh-agent provider state",
                        "prepare hosted OneCLI provider files",
                        "open hosted",
                        "OneCLI",
                        "profile",
                        "credential",
                        "unsafe or mismatched",
                        "MCP",
                        "sidecar",
                        "source",
                        "manifest",
                        "copy",
                        "Permission",
                        "unavailable",
                        "initialization",
                        "timed out",
                        "Claude",
                        "kilroy",
                        "environment",
                        "grant",
                        "provider",
                        "configuration",
                        "refresh",
                        "input bind",
                        "trusted uid/group",
                        "provider home",
                        "resource",
                        "destination",
                        "projection",
                        "stage",
                        "metadata",
                        "path",
                        "readable",
                        "preparation",
                        "version",
                        "changed",
                        "rootless",
                        "directory",
                        "filesystem",
                        "temporary",
                        "failed to start",
                        "failed with status",
                        "original",
                        "origins",
                        "No such file",
                        "resolve",
                        "root",
                        "budget",
                        "bound",
                        "pending",
                        "committed",
                        "publication",
                        "source evidence",
                        "source selection",
                        "source provenance",
                    ] {
                        if text.contains(label) {
                            self.0.push(label);
                        }
                    }
                }
            }
            let mut classes = Classes(Vec::new());
            event.record(&mut classes);
            self.0.lock().unwrap().extend(classes.0);
        }
    }
    let classes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(FailureLayer(classes.clone())),
    )
    .unwrap();
    classes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_amplifier_terminal_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE").unwrap());
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let workspace = fixture.join("workspace");
    let bundle = fixture.join("scenarios/external-amplifier-bundle");
    let skill = home.join(".amplifier/skills/probe");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    let receipt = workspace.join("amplifier-consumed.json");
    for path in [
        &control,
        &runtime,
        &home.join(".amplifier"),
        &bundle.join("modules/context-probe/amplifier_module_context_probe"),
        &bundle.join("modules/loop-probe/amplifier_module_loop_probe"),
        &bundle.join("modules/hooks-probe/amplifier_module_hooks_probe"),
        &skill.join("node_modules/probe-dependency"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    std::fs::write(skill.join("resource"), b"closed-amplifier-resource").unwrap();
    std::fs::write(
        skill.join("node_modules/probe-dependency/index.js"),
        "module.exports='closed-amplifier-dependency'",
    )
    .unwrap();
    std::fs::write(skill.join("run"),"#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('probe-dependency'));").unwrap();
    std::fs::set_permissions(skill.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let context_module = r#"__amplifier_module_type__='context'
import hashlib,json
from pathlib import Path
class Context:
    def __init__(self,session_id,config): self.messages=[]; self.factory=None; self.session_id=session_id; self.config=config
    async def add_message(self,message): self.messages.append(message)
    async def get_messages(self): return list(self.messages)
    async def get_messages_for_request(self,**kwargs): return list(self.messages)
    async def set_messages(self,messages):
        self.messages=list(messages)
        pair=[{'role':m.get('role'),'content':m.get('content')} for m in self.messages if m.get('role') in ['user','assistant']]
        value={'sessionId':self.session_id,'roles':[m['role'] for m in pair],'messageCount':len(pair),'digest':hashlib.sha256(json.dumps(pair,separators=(',',':'),sort_keys=True).encode()).hexdigest()}
        Path(self.config['conversation_receipt']).write_text(json.dumps(value))
    async def clear(self): self.messages=[]
    async def set_system_prompt_factory(self,factory): self.factory=factory
    def get_context_info(self): return {'message_count':len(self.messages),'token_count':0}
async def mount(coordinator,config=None): await coordinator.mount('context',Context(coordinator.session_id,config or {}))
"#;
    let loop_module = r#"__amplifier_module_type__='orchestrator'
class Loop:
    async def execute(self,prompt,context,providers,tools,hooks,**kwargs): raise RuntimeError('model turns are outside this closed startup fixture')
async def mount(coordinator,config=None): await coordinator.mount('orchestrator',Loop())
"#;
    let hook_module = r#"__amplifier_module_type__='hook'
import hashlib,json,os,resource,secrets,subprocess,urllib.request
from pathlib import Path
from amplifier_core import HookResult
from amplifier_app_cli.session_store import SessionStore
from amplifier_foundation import load_bundle
import yaml
_consumer=None
async def mount(coordinator,config=None):
    global _consumer
    config=config or {}
    async def consume(event,data):
        uv=subprocess.check_output(['uv','--version'],text=True).strip()
        output=subprocess.check_output([str(Path.home()/'.amplifier/skills/probe/run')])
        selected=yaml.safe_load((Path.home()/'.amplifier/settings.yaml').read_text())['bundle']['active']
        loaded=await load_bundle(selected)
        loaded.resolve_pending_context()
        contexts={name:hashlib.sha256(loaded.context[name].read_bytes()).hexdigest() for name in ['closed-native-bundle:context/self.md','probe:context/selected.md','same-root:context/selected.md','same-no-root:context/selected.md','unnamed-root:context/selected.md']}
        request=urllib.request.Request(os.environ['FRESHELL_URL']+'/api/mcp',data=b'{}',headers={'x-auth-token':os.environ['FRESHELL_TOKEN']})
        with urllib.request.urlopen(request,timeout=5) as response: authenticated=response.status==200
        seed_receipt=Path(config['receipt']).with_suffix('.seed.json')
        if not seed_receipt.exists():
            store=SessionStore()
            transcript,metadata=store.load(coordinator.session_id)
            if transcript: raise RuntimeError('closed seed setup requires an empty native stub')
            pair=[{'role':'user','content':secrets.token_hex(16)},{'role':'assistant','content':secrets.token_hex(16)}]
            store.save(coordinator.session_id,pair,metadata)
            persisted,persisted_metadata=store.load(coordinator.session_id)
            if persisted!=pair or persisted_metadata.get('session_id')!=coordinator.session_id: raise RuntimeError('closed native seed verification failed')
            value={'sessionId':coordinator.session_id,'roles':[m['role'] for m in pair],'messageCount':len(pair),'digest':hashlib.sha256(json.dumps(pair,separators=(',',':'),sort_keys=True).encode()).hexdigest()}
            seed_receipt.write_text(json.dumps(value))
        argv=Path('/proc/self/cmdline').read_bytes(); env=Path('/proc/self/environ').read_bytes(); strings=[value for value in (argv+env).split(b'\x00') if value]
        stack=resource.getrlimit(resource.RLIMIT_STACK)[0]
        profile={'stackAtLeast8MiB':stack==resource.RLIM_INFINITY or stack>=8388608,'aggregateWithin1MiB':len(argv)+len(env)+8*(len(strings)+2)+len(os.readlink('/proc/self/exe').encode())+1<=1048576,'completeStringsWithin32Pages':all(len(value)+1<=131072 for value in strings)}
        if not all(profile.values()): raise RuntimeError('closed final native execution profile exceeded')
        result={'finalExecProfile':profile,'nativeCallback':event=='on_session_ready','exactIdentity':data.get('session_id')==config['session_id'],'physicalHome':str(Path.home()),'authenticated':authenticated,'scopedAlias':os.environ.get('FRESHELL')=='1','onecli':hashlib.sha256(os.environ.get('OPENAI_API_KEY','').encode()).hexdigest()==config['key_digest'],'nativeModuleInstaller':uv.startswith('uv 0.8.22'),'resourceAndDependency':hashlib.sha256(output).hexdigest(),'nativeNamespaceContexts':contexts}
        Path(config['receipt']).write_text(json.dumps(result))
        return HookResult(action='continue')
    _consumer=consume
    for event in ['session:start','session:resume']: coordinator.hooks.register(event,consume,name='closed-native-probe')
async def on_session_ready(coordinator):
    await _consumer('on_session_ready',{'session_id':coordinator.session_id})
"#;
    for (name, module) in [
        ("context-probe", context_module),
        ("loop-probe", loop_module),
        ("hooks-probe", hook_module),
    ] {
        std::fs::write(
            bundle.join(format!(
                "modules/{name}/amplifier_module_{}/__init__.py",
                name.replace('-', "_")
            )),
            module,
        )
        .unwrap();
    }
    let native_id = "41a04bb3-86f0-463d-97c5-f085e8a9ea4b";
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let conversation_receipt = workspace.join("amplifier-conversation.json");
    std::fs::create_dir_all(bundle.join("behaviors")).unwrap();
    std::fs::create_dir_all(bundle.join("context")).unwrap();
    std::fs::write(
        bundle.join("context/self.md"),
        "native-self-namespace-context",
    )
    .unwrap();
    std::fs::write(
        bundle.join("context/selected.md"),
        "native-nested-namespace-context",
    )
    .unwrap();
    std::fs::create_dir_all(bundle.parent().unwrap().join("context")).unwrap();
    std::fs::write(
        bundle.parent().unwrap().join("context/self.md"),
        "wrong-standalone-parent-context",
    )
    .unwrap();
    let namespace_child = bundle.join("behaviors/probe.yaml");
    let namespace_child_raw="bundle: {name: probe, namespace_root: ..}\ncontext: {include: ['probe:context/selected.md']}\n";
    std::fs::write(&namespace_child, namespace_child_raw).unwrap();
    let mut namespace_includes = vec![format!("file://{}", namespace_child.display())];
    for (name, ancestor_name, override_root) in [
        ("same-root", "same-root", true),
        ("same-no-root", "same-no-root", false),
        ("unnamed-root", "", true),
    ] {
        let root = fixture.join(format!("scenarios/{name}"));
        std::fs::create_dir_all(root.join("context")).unwrap();
        std::fs::create_dir_all(root.join("behaviors/context")).unwrap();
        std::fs::write(
            root.join("bundle.yaml"),
            format!("bundle: {{name: {ancestor_name:?}}}\n"),
        )
        .unwrap();
        let child = root.join("behaviors/probe.yaml");
        std::fs::write(&child, format!("bundle: {{name: {name}{}}}\ncontext: {{include: ['{name}:context/selected.md']}}\n", if override_root {", namespace_root: .."} else {""})).unwrap();
        std::fs::write(
            root.join("context/selected.md"),
            format!("native-{name}-ancestor-context"),
        )
        .unwrap();
        std::fs::write(
            root.join("behaviors/context/selected.md"),
            "wrong-child-context-decoy",
        )
        .unwrap();
        namespace_includes.push(format!("file://{}", child.display()));
    }
    let bundle_document=format!("bundle:\n  name: closed-native-bundle\n  namespace_root: ..\nincludes: {}\ncontext: {{include: ['closed-native-bundle:context/self.md']}}\nsession:\n  orchestrator:\n    module: loop-probe\n    source: ./modules/loop-probe\n  context:\n    module: context-probe\n    source: ./modules/context-probe\n    config:\n      conversation_receipt: {}\nproviders:\n  - module: provider-vllm\n    config:\n      base_url: http://127.0.0.1:9\n      default_model: closed-model-free\nhooks:\n  - module: hooks-probe\n    source: ./modules/hooks-probe\n    config:\n      receipt: {}\n      session_id: {}\n      key_digest: {}\n",serde_json::to_string(&namespace_includes).unwrap(),serde_json::to_string(conversation_receipt.to_str().unwrap()).unwrap(),serde_json::to_string(receipt.to_str().unwrap()).unwrap(),native_id,hash(b"synthetic-amplifier-onecli-value"));
    std::fs::write(bundle.join("bundle.yaml"), &bundle_document).unwrap();
    let settings = "bundle:\n  active: ../scenarios/external-amplifier-bundle/bundle.yaml\nproviders:\n  - module: provider-vllm\n    config:\n      base_url: http://127.0.0.1:9\n      default_model: closed-model-free\n".to_owned();
    std::fs::write(home.join(".amplifier/settings.yaml"), &settings).unwrap();
    let env_file = fixture.join("grants/environment.env");
    std::fs::write(
        &env_file,
        "OPENAI_API_KEY=synthetic-amplifier-onecli-value\nOPENAI_BASE_URL=http://127.0.0.1:9\n",
    )
    .unwrap();
    std::fs::set_permissions(&env_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::env::set_var("FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE", &env_file);
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "amplifier");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let backend = Arc::new(BrokerAuthorizedBackend {
        real: DockerEngineBackend::new(fixture.join("broker.sock")),
        cold_backend: Default::default(),
        control: control.clone(),
        handoff: fixture.join("handoff"),
        certificate_sentinel: b"synthetic-amplifier-onecli-value".to_vec(),
    });
    let supervisor_config = SupervisorConfig {
        runtime_root: runtime,
        control_socket_path: socket.clone(),
        host_binary_path: PathBuf::from(
            std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
        ),
        image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
        test_run_id: std::env::var("FRESHELL_PROVIDER_LAUNCH_RUN_ID").unwrap(),
        control_secret: "closed-synthetic-control-secret".into(),
        lifecycle_log: fixture.join("lifecycle.jsonl"),
        admission: AdmissionPolicy::default(),
    };
    let supervisor =
        Supervisor::new(registry.clone(), backend.clone(), supervisor_config.clone()).unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let web = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = web.local_addr().unwrap().port();
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::new("closed-synthetic-web-token".to_string()),
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for name in [
        "FRESHELL_MANAGED_RUNTIME_V1",
        "FRESHELL_MANAGED_FRESH_AGENT_V1",
    ] {
        std::env::set_var(name, "1");
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = workspace.to_str().unwrap().to_string();
    let ambient_home = fixture.join("ambient-home");
    std::fs::create_dir_all(ambient_home.join(".amplifier")).unwrap();
    std::fs::write(
        ambient_home.join(".amplifier/settings.yaml"),
        "bundle:\n  active: ./missing-ambient-decoy\n",
    )
    .unwrap();
    std::env::set_var("HOME", &ambient_home);
    let terminal = controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "amplifier".into(),
                args: vec![
                    "session".into(),
                    "resume".into(),
                    "--full-history".into(),
                    native_id.into(),
                ],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::from([("HOME".into(), home.to_str().unwrap().into())]),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "amplifier".into(),
            resume_session_id: Some(native_id.into()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await
        .expect("complete native Amplifier terminal startup");
    let client = controller.runtime_client();
    let observed = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if let Ok(bytes) = std::fs::read(&receipt) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    break value;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .ok();
    if observed.is_some() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let output = client
        .read_output(
            SoulId::parse(terminal.soul_id.clone()).unwrap(),
            0,
            64 * 1024,
        )
        .await
        .unwrap();
    if observed.is_none() || output.exited {
        let text = crate::ai_title::strip_ansi(
            &output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>(),
        );
        let classes = [
            "ENOENT",
            "EACCES",
            "Module",
            "module",
            "provider",
            "Provider",
            "orchestrator",
            "context",
            "Error",
            "Error:",
            "failed",
            "Traceback",
            "installed",
            "Installing",
            "dependency",
            "missing",
            "Permission",
            "session",
            "Session",
            "bundle",
            "Bundle",
            "setup",
            "configure",
            "No module named",
            "ModuleNotFoundError",
            "ImportError",
            "TypeError",
            "AttributeError",
            "ValidationError",
            "RuntimeError",
            "FileNotFoundError",
            "PermissionError",
            "ModuleLoadError",
            "ModuleValidationError",
            "Failed to install",
            "Failed to load",
            "Failed to mount",
            "Failed to initialize",
            "Failed to resolve",
            "not found",
            "not installed",
            "pyproject.toml",
            "No solution found",
            "network",
            "Connection",
            "loop-probe",
            "context-probe",
            "hooks-probe",
            "provider-vllm",
            "orchestrator missing",
            "context missing",
            "required",
            "abstract",
            "signature",
            "source",
            "not found in prepared bundle",
            "no source hint",
            "activation failed",
            "Failed to activate",
            "Failed to lazy-activate",
            "does not exist",
            "entry points or filesystem",
            "has no valid Python package",
            "failed validation",
            "Mount function",
            "must be async",
            "No pyproject.toml",
            "Could not find",
            "Cannot find",
            "Could not load",
            "Module source",
            "Source path",
            "All configured",
            "not available",
            "not mounted",
            "install dependencies",
            "dependency installation",
            "No context module",
            "No orchestrator module",
            "not a valid",
            "parse",
            "activate",
            "resolve",
            "validate",
            "uv is not installed",
            "File not found:",
            "No such file or directory",
            "Read-only file system",
            "Permission denied",
            "Failed to install module",
            "No providers",
            "No context",
            "No orchestrator",
            "Failed to initialize session",
            "validation",
            "mount",
            "uv",
            "pip",
            "base_url",
            "session_id",
            "attribute",
            "await",
            "Context",
            "dict",
            "Prompt",
            "factory",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        // Emit only finite diagnostic labels; paths, credentials, arbitrary
        // exception payloads and provider output never enter the test log.
        let labels = "error failed unable cannot could not create remove write read only readonly filesystem permission denied temporary directory file path uv pip install installed package build backend fetch download resolve git clone network connection certificate tls ssl python virtual environment target source module cache lock resource unavailable no such system command subprocess status exit stdout stderr caused by requires version dependency dependencies hooks-mode modes hatchling setuptools attribute object dict await coroutine context set_system_prompt_factory get_context_info config keys data serialize tuple type callable required schema factory prompt"
            .split_whitespace().collect::<Vec<_>>();
        let classified_errors = text
            .lines()
            .filter(|line| {
                let line = line.to_ascii_lowercase();
                line.contains("error") || line.contains("failed") || line.contains("caused by")
            })
            .take(16)
            .map(|line| {
                line.split(|ch: char| !ch.is_ascii_alphabetic() && ch != '-')
                    .filter_map(|word| {
                        labels
                            .iter()
                            .copied()
                            .find(|label| word.eq_ignore_ascii_case(label))
                    })
                    .take(80)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"provider":"amplifier","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes,"classifiedErrors":classified_errors})
        );
    }
    let expected = json!({"finalExecProfile":native_exec_profile(),"nativeCallback":true,"exactIdentity":true,"physicalHome":"/home/freshell/provider","authenticated":true,"scopedAlias":true,"onecli":true,"nativeModuleInstaller":true,"resourceAndDependency":hash(b"closed-amplifier-resource:closed-amplifier-dependency"),"nativeNamespaceContexts":{"closed-native-bundle:context/self.md":hash(b"native-self-namespace-context"),"probe:context/selected.md":hash(b"native-nested-namespace-context"),"same-root:context/selected.md":hash(b"native-same-root-ancestor-context"),"same-no-root:context/selected.md":hash(b"native-same-no-root-ancestor-context"),"unnamed-root:context/selected.md":hash(b"native-unnamed-root-ancestor-context")}});
    assert_eq!(observed.expect("real Amplifier must activate selected local module and executable skill before a model turn"),expected);
    assert!(
        !output.exited,
        "native Amplifier must remain usable after the initialization consumer"
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"amplifier","route":"terminal","finalExecProfile":native_exec_profile(),"digest":hash(serde_json::to_vec(&expected).unwrap().as_slice())})
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".amplifier/settings.yaml")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_to_string(bundle.join("bundle.yaml")).unwrap(),
        bundle_document
    );
    let soul = SoulId::parse(terminal.soul_id.clone()).unwrap();
    let prior = registry.active_handle_for_soul(soul.clone()).await.unwrap();
    let prior_generation = prior
        .terminal()
        .unwrap()
        .provider_launch_context
        .as_ref()
        .unwrap()
        .prepared_inputs
        .as_ref()
        .unwrap()
        .generation_id
        .clone();
    let hidden_home = fixture.join("source-home-unavailable");
    std::fs::rename(&home, &hidden_home).unwrap();
    let healthy = client
        .recover(soul.clone(), RecoveryTrigger::HostUnreachable)
        .await
        .unwrap();
    assert_eq!(healthy.outcome, RecoveryOutcome::Reattached);
    let attached = registry.active_handle_for_soul(soul.clone()).await.unwrap();
    assert_eq!(attached.incarnation_id(), prior.incarnation_id());
    assert_eq!(attached.container_id(), prior.container_id());
    assert_eq!(
        attached.provider_volume_name(),
        prior.provider_volume_name()
    );
    // Reopen real production registry/supervisor/controller instances, keeping
    // the same provider-owned volume and frozen preparation authority. Joining
    // the old control listener cannot stop the independently owned native CLI.
    drop(controller);
    control_task.abort();
    let _ = control_task.await;
    drop(registry);
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    let supervisor = Supervisor::new(registry.clone(), backend, supervisor_config).unwrap();
    std::fs::remove_file(&socket).unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let _cold_controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let client = freshell_runtime_client::RuntimeClient::new(
        socket.clone(),
        "closed-synthetic-control-secret",
    );
    let cold = client
        .recover(soul.clone(), RecoveryTrigger::HostUnreachable)
        .await
        .unwrap();
    assert_eq!(cold.outcome, RecoveryOutcome::Reattached);
    let cold_handle = registry.active_handle_for_soul(soul.clone()).await.unwrap();
    assert_eq!(cold_handle.incarnation_id(), prior.incarnation_id());
    assert_eq!(cold_handle.container_id(), prior.container_id());
    assert_eq!(
        cold_handle.provider_volume_name(),
        prior.provider_volume_name()
    );
    assert_eq!(
        cold_handle
            .terminal()
            .unwrap()
            .provider_launch_context
            .as_ref()
            .unwrap()
            .prepared_inputs
            .as_ref()
            .unwrap()
            .generation_id,
        prior_generation
    );
    let real = DockerEngineBackend::new(fixture.join("broker.sock"));
    real.force_stop(&prior)
        .await
        .expect("stop only exact registry-owned Amplifier fixture runtime");
    assert!(real.verify_empty(&prior).await.unwrap());
    std::fs::remove_file(&receipt).unwrap();
    let recovered = tokio::time::timeout(
        Duration::from_secs(120),
        client.recover(soul.clone(), RecoveryTrigger::HostUnreachable),
    )
    .await
    .expect("finite actual Amplifier native recovery")
    .unwrap();
    println!(
        "provider_recovery_outcome {}",
        json!({"provider":"amplifier","outcome":recovered.outcome,"probe":recovered.probe.as_ref().map(|probe|match probe {RecoveryProbe::ResumeReady {..}=>"native_resume",RecoveryProbe::PristineSeedReady {..}=>"pristine_seed",_=>"other"})})
    );
    if let Some(RecoveryProbe::Blocked {
        reason, retry_hint, ..
    }) = &recovered.probe
    {
        let repair = retry_hint.repair.as_deref().unwrap_or("");
        let labels = [
            "manifest",
            "copy",
            "symlink",
            "changed",
            "ordinary",
            "projection",
            "bundle",
            "module",
            "mount",
            "native",
            "session",
            "store",
            "helper",
            "metadata",
            "cwd",
            "credential",
            "bootstrap",
            "runtime",
            "image",
            "missing",
            "unavailable",
            "frozen",
            "already exists",
            "conflict",
            "private",
            "reference",
            "failed",
            "read",
            "write",
            "input",
            "selection",
            "permission",
            "host",
            "grant",
            "socket",
            "closed",
            "auth",
            "secret",
            "environment",
            "capability",
            "lease",
            "volume",
            "scope",
            "ownership",
        ];
        println!(
            "provider_recovery_diagnostic {}",
            json!({"provider":"amplifier","reason":reason,"repairBytes":repair.len(),"repairClasses":labels.into_iter().filter(|label|repair.to_ascii_lowercase().contains(label)).collect::<Vec<_>>()})
        );
        for line in std::fs::read_to_string(fixture.join("lifecycle.jsonl"))
            .unwrap()
            .lines()
        {
            if let Ok(event) = serde_json::from_str::<Value>(line) {
                if event["event"] == "supervisor.activation_failed"
                    || event["event"] == "supervisor.recovery.activation_failed"
                {
                    println!(
                        "provider_activation_diagnostic {}",
                        json!({"event":event["event"],"stage":event["data"]["stage"],"errorCode":event["data"]["errorCode"],"errorClass":event["data"]["errorClass"]})
                    );
                }
            }
        }
    }
    assert_eq!(recovered.outcome, RecoveryOutcome::Replaced);
    assert!(
        matches!(recovered.probe, Some(RecoveryProbe::ResumeReady { .. })),
        "existing completed conversation must use genuine native resume"
    );
    let current = registry.active_handle_for_soul(soul.clone()).await.unwrap();
    assert_ne!(current.incarnation_id(), prior.incarnation_id());
    assert_eq!(current.provider_volume_name(), prior.provider_volume_name());
    let generation = &current
        .terminal()
        .unwrap()
        .provider_launch_context
        .as_ref()
        .unwrap()
        .prepared_inputs
        .as_ref()
        .unwrap()
        .generation_id;
    assert_ne!(generation, &prior_generation);
    let expected_conversation: Value = serde_json::from_slice(
        &std::fs::read(receipt.with_extension("seed.json"))
            .expect("native writer's completed pair receipt"),
    )
    .unwrap();
    assert_eq!(expected_conversation["sessionId"], native_id);
    assert_eq!(expected_conversation["roles"], json!(["user", "assistant"]));
    assert_eq!(expected_conversation["messageCount"], 2);
    assert_eq!(expected_conversation["digest"].as_str().unwrap().len(), 64);
    let restored = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if let Ok(bytes) = std::fs::read(&conversation_receipt) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    break value;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .ok();
    if restored.is_none() {
        let output = client
            .read_output(soul.clone(), 0, 64 * 1024)
            .await
            .unwrap();
        let text = crate::ai_title::strip_ansi(
            &output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>(),
        );
        let labels = [
            "Error",
            "failed",
            "Traceback",
            "No such file",
            "Permission denied",
            "not found",
            "bundle",
            "Bundle",
            "source",
            "Source",
            "context",
            "Context",
            "session",
            "Session",
            "ModuleNotFoundError",
            "ModuleLoadError",
            "ModuleValidationError",
            "FileNotFoundError",
            "RuntimeError",
            "TypeError",
            "AttributeError",
            "not installed",
            "not mounted",
            "missing",
            "resolve",
            "activate",
            "initialize",
            "load",
            "transcript",
            "history",
            "No module named",
            "Failed to activate",
            "Could not find",
            "does not exist",
            "Invalid",
            "uv",
            "read-only",
            "reference",
            "settings",
        ];
        println!(
            "provider_conversation_diagnostic {}",
            json!({"provider":"amplifier","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"nativeStartupConsumerExists":receipt.exists(),"originalBundleMentioned":text.contains(bundle.to_str().unwrap()),"projectedBundleMentioned":text.contains("/home/freshell/provider/.freshell/resources/amplifier-local-0"),"fileSourceMissing":text.contains("File source not found"),"classes":labels.into_iter().filter(|label|text.contains(label)).collect::<Vec<_>>() })
        );
    }
    assert_eq!(
        restored.expect(
            "genuine native resume must restore the completed pair into its actual context"
        ),
        expected_conversation
    );
    assert!(!home.exists());
    println!(
        "provider_recovery_consumer {}",
        json!({"provider":"amplifier","route":"terminal","outcome":recovered.outcome,"sameOwnedHome":true,"originalOrdinaryUnavailable":true,"priorGeneration":prior_generation,"generationId":generation,"nativeSessionId":native_id,"messageCount":2,"conversationDigest":expected_conversation["digest"],"healthyReattachSameRuntime":true,"coldProductionConstructorsReopened":true})
    );
    let accepted_inputs = current
        .terminal()
        .unwrap()
        .provider_launch_context
        .as_ref()
        .unwrap()
        .prepared_inputs
        .as_ref()
        .unwrap();
    let accepted_manifest = control
        .join("provider-roots")
        .join(generation)
        .join(&accepted_inputs.manifest.relative_path);
    assert!(
        !client
            .read_output(soul.clone(), 0, 64 * 1024)
            .await
            .unwrap()
            .exited,
        "replacement native process must remain usable before authority loss"
    );
    std::fs::rename(
        &accepted_manifest,
        accepted_manifest.with_extension("unavailable"),
    )
    .unwrap();
    let still_live = client
        .recover(soul.clone(), RecoveryTrigger::HostUnreachable)
        .await
        .unwrap();
    if still_live.outcome != RecoveryOutcome::Reattached {
        let output = client.read_output(soul.clone(), 0, 64 * 1024).await.ok();
        let text = crate::ai_title::strip_ansi(
            &output
                .as_ref()
                .map(|output| {
                    output
                        .frames
                        .iter()
                        .map(|frame| frame.data.as_str())
                        .collect::<String>()
                })
                .unwrap_or_default(),
        );
        let labels = [
            "Error",
            "failed",
            "Traceback",
            "AttributeError",
            "TypeError",
            "KeyError",
            "get_messages",
            "get_context_info",
            "set_messages",
            "session",
            "context",
            "Context",
            "bundle",
            "source",
            "manifest",
            "token",
            "message",
            "dict",
            "list",
            "Permission denied",
            "not found",
        ];
        let probe = match &still_live.probe {
            Some(RecoveryProbe::Blocked { path, reason, .. }) => {
                json!({"path":path,"reason":reason})
            }
            _ => json!(null),
        };
        let inspection = match real.inspect(&current).await {
            Ok(value) => json!({"state":format!("{:?}",value.state)}),
            Err(error) => {
                let text = error.to_string();
                let labels = [
                    "manifest",
                    "metadata",
                    "prepared",
                    "provider",
                    "source",
                    "unavailable",
                    "changed",
                    "missing",
                    "ownership",
                    "mount",
                    "file",
                ];
                json!({"errorClasses":labels.into_iter().filter(|label|text.to_ascii_lowercase().contains(label)).collect::<Vec<_>>()})
            }
        };
        println!(
            "provider_environment_authority_diagnostic {}",
            json!({"provider":"amplifier","outcome":still_live.outcome,"probe":probe,"inspection":inspection,"outputAvailable":output.is_some(),"exited":output.as_ref().map(|value|value.exited),"exitCode":output.as_ref().and_then(|value|value.exit_code),"outputBytes":text.len(),"classes":labels.into_iter().filter(|label|text.contains(label)).collect::<Vec<_>>() })
        );
    }
    assert_eq!(still_live.outcome, RecoveryOutcome::Reattached);
    assert_eq!(
        registry
            .active_handle_for_soul(soul.clone())
            .await
            .unwrap()
            .container_id(),
        current.container_id()
    );
    real.force_stop(&current)
        .await
        .expect("stop only the exact replacement fixture runtime");
    assert!(real.verify_empty(&current).await.unwrap());
    let blocked = tokio::time::timeout(
        Duration::from_secs(120),
        client.recover(soul.clone(), RecoveryTrigger::HostUnreachable),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(blocked.outcome, RecoveryOutcome::Blocked);
    assert!(
        matches!(blocked.probe, Some(RecoveryProbe::Blocked { reason, .. }) if reason != freshell_runtime_protocol::RecoveryBlockReason::StoreMissing)
    );
    let retained = registry
        .owned_handle(current.incarnation_id().clone())
        .await
        .unwrap();
    assert_eq!(retained.incarnation_id(), current.incarnation_id());
    assert_eq!(
        retained.provider_volume_name(),
        current.provider_volume_name()
    );
    assert_eq!(
        retained
            .terminal()
            .unwrap()
            .provider_launch_context
            .as_ref()
            .unwrap()
            .prepared_inputs
            .as_ref()
            .unwrap()
            .generation_id,
        *generation
    );
    assert_eq!(
        std::fs::read_dir(fixture.join("handoff"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json"))
            .count(),
        2
    );
    println!(
        "provider_environment_authority_consumer {}",
        json!({"provider":"amplifier","outcome":blocked.outcome,"healthyReattachSameRuntime":true,"acceptedGenerationRetained":true,"nativeNotRedispatched":true,"nativeStoreAbsenceNotInferred":true})
    );
    std::fs::rename(&hidden_home, &home).unwrap();
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    web_task.abort();
    control_task.abort();
    let _ = web_task.await;
    let _ = control_task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_claude_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    let failure_classes = capture_fresh_launch_failure_classes();
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE").expect("closed Claude launch fixture"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let selected_config = home.join("selected-config");
    let workspace = fixture.join("workspace");
    let plugin = home.join("selected-plugin");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    for path in [
        &control,
        &runtime,
        &home.join(".claude"),
        &selected_config,
        &plugin.join(".claude-plugin"),
        &plugin.join("hooks"),
        &plugin.join("scripts/node_modules/probe-dependency"),
        &plugin.join("skills/probe"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    let disabled_project_memory = workspace.join("CLAUDE.md");
    let disabled_project_settings = workspace.join(".claude/settings.json");
    std::fs::create_dir_all(workspace.join(".claude")).unwrap();
    std::fs::write(&disabled_project_memory, "@missing-disabled-project.md\n").unwrap();
    std::fs::write(
        &disabled_project_settings,
        r#"{"env":{"CLAUDE_SELECTED_NONCE":"disabled-project-decoy"}}"#,
    )
    .unwrap();
    let receipt = workspace.join("claude-consumed.json");
    let instructions_receipt = workspace.join("claude-import-consumed.json");
    let memory = format!(
        "closed-claude-global-memory\n@../imported-memory.md\n@../selected-plugin/relative-memory.md\n@~/selected-plugin/home-memory.md\n@{}/absolute-memory.md\n@../selected-plugin/spaced\\ memory.md\n`@../selected-plugin/ignored-inline.md`\n```\n@../selected-plugin/ignored-fence.md\n```\n@\"../selected-plugin/ignored-quoted.md\"\n",
        plugin.display()
    ).into_bytes();
    std::fs::write(
        home.join("imported-memory.md"),
        b"closed-claude-imported-memory\n@./selected-plugin/nested-memory.md\n",
    )
    .unwrap();
    std::fs::write(selected_config.join("CLAUDE.md"), &memory).unwrap();
    std::fs::create_dir_all(selected_config.join("rules/nested")).unwrap();
    let rule = "@../../../rule-memory.md\n`@../../../missing-rule-code.md`\n```\n@../../../missing-rule-fence.md\n```\n";
    std::fs::write(selected_config.join("rules/nested/policy.md"), rule).unwrap();
    std::fs::write(home.join("rule-memory.md"), "closed-selected-rule-memory\n").unwrap();
    std::fs::write(
        home.join(".claude/CLAUDE.md"),
        "@../missing-unselected-default.md\n",
    )
    .unwrap();
    for name in [
        "relative-memory.md",
        "home-memory.md",
        "absolute-memory.md",
        "spaced memory.md",
        "nested-memory.md",
        "ignored-inline.md",
        "ignored-fence.md",
        "ignored-quoted.md",
    ] {
        std::fs::write(plugin.join(name), format!("closed-native-{name}")).unwrap();
    }
    let settings = r#"{"env":{"CLAUDE_SELECTED_NONCE":"closed-selected-settings"}}"#;
    std::fs::write(selected_config.join("settings.json"), settings).unwrap();
    std::fs::write(
        home.join(".claude/settings.json"),
        r#"{"env":{"CLAUDE_SELECTED_NONCE":"unselected-default"}}"#,
    )
    .unwrap();
    std::fs::write(plugin.join("skills/probe/SKILL.md"),"---\nname: closed-plugin-probe\ndescription: selected complete native plugin\n---\nUse the adjacent resources.\n").unwrap();
    std::fs::write(plugin.join("scripts/resource"), b"closed-claude-resource").unwrap();
    // Ordinary selected resources must use their disk budget, not the
    // workload's deliberately small temporary-memory filesystem.
    let disk_resource = vec![0x5a; 128 * 1024 * 1024];
    std::fs::write(plugin.join("scripts/disk-resource"), &disk_resource).unwrap();
    std::fs::write(
        plugin.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-claude-dependency'\n",
    )
    .unwrap();
    std::fs::write(
        plugin.join("scripts/run"),
        "#!/bin/sh\ncat \"$(dirname \"$0\")/resource\"\n",
    )
    .unwrap();
    std::fs::set_permissions(
        plugin.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let consumer = r#"const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{
 const input=JSON.parse(raw),root=path.resolve(__dirname,'..');
 const endpoint=process.env.FRESHELL_URL,token=process.env.FRESHELL_TOKEN;
 const authenticated=await new Promise(resolve=>{if(!endpoint||!token)return resolve(false);const req=http.request(new URL('/api/mcp',endpoint),{method:'POST',headers:{'x-auth-token':token}},res=>{res.resume();resolve(res.statusCode===200)});req.on('error',()=>resolve(false));req.end('{}')});
 const record={finalExecProfile:nativeExecProfile('claude'),hook:input.hook_event_name==='SessionStart',physicalHome:process.env.HOME,nativeIdentity:{uid:process.getuid(),euid:process.geteuid(),gid:process.getgid(),egid:process.getegid(),groups:[...new Set([...process.getgroups(),process.getegid()])].sort((a,b)=>a-b)},settings:['closed-selected-settings','closed-explicit-settings'].includes(process.env.CLAUDE_SELECTED_NONCE),authenticated,scopedAlias:process.env.FRESHELL==='1',onecli:hash(process.env.ANTHROPIC_API_KEY||'')===process.argv[3],
 refreshStageAbsent:fs.readdirSync(process.env.HOME).every(name=>!name.startsWith('.freshell-provider-refresh-')),
 memory:hash(fs.readFileSync(path.join(process.env.HOME,'.claude/CLAUDE.md'))),skill:hash(fs.readFileSync(path.join(root,'skills/probe/SKILL.md'))),resource:hash(require('node:child_process').execFileSync(path.join(__dirname,'run'))),diskResource:hash(fs.readFileSync(path.join(__dirname,'disk-resource'))),dependency:hash(require('probe-dependency'))};
 fs.writeFileSync(process.argv[2],JSON.stringify(record));
});
"#;
    let consumer = format!("{NATIVE_EXEC_PROFILE}{consumer}");
    std::fs::write(plugin.join("scripts/consume.cjs"), &consumer).unwrap();
    let flag_receipt = workspace.join("claude-flag-receipt.json");
    std::fs::write(plugin.join("scripts/flag.cjs"), "const fs=require('node:fs'),crypto=require('node:crypto');const hash=v=>crypto.createHash('sha256').update(v).digest('hex');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);fs.writeFileSync(process.argv[2],JSON.stringify({flag:input.hook_event_name==='SessionStart'&&process.env.CLAUDE_SELECTED_NONCE==='closed-explicit-settings',resource:hash(require('node:child_process').execFileSync(__dirname+'/run')),dependency:hash(require('probe-dependency'))}))})").unwrap();
    let flag_commands = selected_config.join("commands");
    std::fs::create_dir_all(flag_commands.join("node_modules/probe-dependency")).unwrap();
    for relative in [
        "flag.cjs",
        "run",
        "resource",
        "node_modules/probe-dependency/index.js",
    ] {
        std::fs::copy(
            plugin.join("scripts").join(relative),
            flag_commands.join(relative),
        )
        .unwrap();
    }
    let flag_origin = selected_config.join("explicit-origin");
    std::fs::create_dir(&flag_origin).unwrap();
    let flag_settings = flag_origin.join("settings.json");
    let flag_value = json!({"env":{"CLAUDE_SELECTED_NONCE":"closed-explicit-settings"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("node \"../source-home/selected-config/commands/flag.cjs\" {}",serde_json::to_string(flag_receipt.to_str().unwrap()).unwrap()),"timeout":10}]}]}});
    let flag_bytes = serde_json::to_vec(&flag_value).unwrap();
    std::fs::write(&flag_settings, &flag_bytes).unwrap();
    let flag_alias = selected_config.join("selected-settings.json");
    std::os::unix::fs::symlink(&flag_settings, &flag_alias).unwrap();
    let settings_form = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_SETTINGS_FORM")
        .unwrap_or_else(|_| "file".into());
    let source_guard = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_SOURCE_GUARD")
        .unwrap_or_else(|_| "unchanged".into());
    assert!(matches!(
        source_guard.as_str(),
        "unchanged" | "changed-git" | "retained" | "retained-fresh"
    ));
    let changed_git = source_guard == "changed-git";
    let retained_fresh = source_guard == "retained-fresh";
    let flag_argument = match settings_form.as_str() {
        "file" if changed_git => flag_alias.to_str().unwrap().into(),
        "file" => "../source-home/selected-config/selected-settings.json".into(),
        "inline" => String::from_utf8(flag_bytes.clone()).unwrap(),
        "owned-last" => freshell_platform::cli_launch::claude_settings_json(
            freshell_platform::cli_launch::ProviderTarget::Unix,
        ),
        _ => panic!("closed fixture settings form must be file, inline or owned-last"),
    };
    let instructions_consumer = r#"const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
 const input=JSON.parse(raw),name=path.basename(input.file_path||''),event=input.hook_event_name==='InstructionsLoaded';
 const names=['imported-memory.md','relative-memory.md','home-memory.md','absolute-memory.md','spaced memory.md','nested-memory.md','rule-memory.md'];
 const selected=event&&names.includes(name)?{name,digest:crypto.createHash('sha256').update(fs.readFileSync(input.file_path)).digest('hex')}:null;
 fs.appendFileSync(process.argv[2]+'.events',JSON.stringify({event,global:input.file_path===process.env.HOME+'/.claude/CLAUDE.md',project:input.file_path===process.argv[3],ignored:event&&name.startsWith('ignored-'),selected})+'\n');
 if(event&&input.file_path===process.env.HOME+'/imported-memory.md')fs.writeFileSync(process.argv[2],JSON.stringify({nativeImport:true,digest:selected.digest}));
});
"#;
    std::fs::write(
        plugin.join("scripts/instructions.cjs"),
        instructions_consumer,
    )
    .unwrap();
    let manifest = json!({"name":"closed-selected-plugin","version":"1.0.0","skills":"./skills","hooks":"./hooks/hooks.json"});
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let key_digest = format!("{:x}", Sha256::digest(b"synthetic-claude-onecli-value"));
    let hooks = json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("node \"${{CLAUDE_PLUGIN_ROOT}}/scripts/consume.cjs\" {} {}",serde_json::to_string(receipt.to_str().unwrap()).unwrap(),key_digest),"timeout":10}]}]}});
    let mut hooks = hooks;
    hooks["hooks"]["InstructionsLoaded"] = json!([{"hooks":[{"type":"command","command":format!("node \"${{CLAUDE_PLUGIN_ROOT}}/scripts/instructions.cjs\" {} {}",serde_json::to_string(instructions_receipt.to_str().unwrap()).unwrap(),serde_json::to_string(disabled_project_memory.to_str().unwrap()).unwrap()),"timeout":10}]}]);
    std::fs::write(
        plugin.join("hooks/hooks.json"),
        serde_json::to_vec(&hooks).unwrap(),
    )
    .unwrap();
    let validated = std::process::Command::new("claude")
        .args(["plugin", "validate"])
        .arg(&plugin)
        .env("HOME", &home)
        .output()
        .unwrap();
    assert!(
        validated.status.success(),
        "native terminal plugin schema prerequisite failed"
    );
    let env_file = fixture.join("grants/environment.env");
    std::fs::write(
        &env_file,
        "ANTHROPIC_API_KEY=synthetic-claude-onecli-value\nANTHROPIC_BASE_URL=http://127.0.0.1:9\n",
    )
    .unwrap();
    std::fs::set_permissions(&env_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::env::set_var("FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE", &env_file);
    std::env::set_var("CLAUDE_CONFIG_DIR", &selected_config);
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "claude");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(BrokerAuthorizedBackend {
            real: DockerEngineBackend::new(fixture.join("broker.sock")),
            cold_backend: Default::default(),
            control: control.clone(),
            handoff: fixture.join("handoff"),
            certificate_sentinel: b"synthetic-claude-onecli-value".to_vec(),
        }),
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: PathBuf::from(
                std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
            ),
            image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
            test_run_id: std::env::var("FRESHELL_PROVIDER_LAUNCH_RUN_ID").unwrap(),
            control_secret: "closed-synthetic-control-secret".into(),
            lifecycle_log: fixture.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let web = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = web.local_addr().unwrap().port();
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::new("closed-synthetic-web-token".to_string()),
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for name in [
        "FRESHELL_MANAGED_RUNTIME_V1",
        "FRESHELL_MANAGED_FRESH_AGENT_V1",
    ] {
        std::env::set_var(name, "1");
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    async fn qualify_private_source_reader(
        client: &freshell_runtime_client::RuntimeClient,
        soul: SoulId,
        provider: &str,
        seed: &str,
        workspace: &Path,
        runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
    ) -> Value {
        use freshell_platform::claude_inputs::{observation::LocalDecision, ClaudeSettingSource};
        use std::os::unix::fs::MetadataExt;
        let cwd = workspace.join("source-observer/nested");
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();
        let local = cwd.join(".claude/settings.local.json");
        std::fs::write(&local, b"{}").unwrap();
        let reservation = client
            .reserve_provider_inputs(soul.clone(), provider.into(), seed.into())
            .await
            .expect("same initial creation must reserve absent HOME before source observation");
        let request = ObserveClaudeSourcesRequest {
            expected_control_epoch: None,
            soul_id: soul,
            provider: provider.into(),
            authority: ClaudeSourceAuthority::InitialReservation {
                reservation_id: reservation.reservation_id,
            },
            workspace_path: workspace.to_str().unwrap().into(),
            git_common_dir: None,
            candidate: None,
            observation_request:
                freshell_platform::claude_inputs::observation::ObservationRequest {
                    version: 1,
                    request_id: uuid::Uuid::new_v4().to_string(),
                    native_source_runtime: runtime,
                    cwd: cwd.clone(),
                    home: "/home/freshell/provider".into(),
                    setting_sources: vec![ClaudeSettingSource::Local],
                    selector_manifest_sha256: "a".repeat(64),
                    plan_revision: 0,
                    candidate_binding: None,
                },
        };
        let reply = client.observe_claude_sources(request).await.expect(
            "actual scoped private source reader must finish and clean up before native creation",
        );
        let observed = reply.observation;
        assert_eq!(
            (observed.uid, observed.euid, observed.gid, observed.egid),
            (65534, 65534, 0, 0)
        );
        assert_eq!(observed.native_source_runtime, runtime);
        assert_eq!(observed.cwd, cwd);
        assert_eq!(
            observed.home.as_deref(),
            Some(Path::new("/home/freshell/provider"))
        );
        let owner = std::fs::metadata(workspace).unwrap().uid();
        assert_ne!(
            owner, 65534,
            "fixture ownership must exercise the actual reader UID predicate"
        );
        assert_eq!(observed.root_uid, Some(owner));
        assert_eq!(observed.local_decision, LocalDecision::RootOwnerMismatch);
        let roots = observed.roots.unwrap();
        assert_eq!(roots.checkout, workspace);
        assert_eq!(roots.canonical, workspace);
        assert_eq!(observed.local_settings, [local.clone()]);
        assert_eq!(std::fs::read(&local).unwrap(), b"{}");
        println!(
            "provider_source_observer {}",
            json!({"runtime":runtime,"uid":observed.uid,"gid":observed.gid,"supplementaryGroups":observed.supplementary_groups,"decision":observed.local_decision,"localCount":observed.local_settings.len(),"sourceBytesPreserved":true})
        );
        let mut groups = observed.supplementary_groups.clone();
        groups.push(observed.egid);
        groups.sort_unstable();
        groups.dedup();
        json!({"uid":observed.uid,"euid":observed.euid,"gid":observed.gid,"egid":observed.egid,"groups":groups})
    }
    let client = controller.runtime_client();
    let source_provider =
        if std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_FLAVOR").as_deref() == Ok("kilroy") {
            "kilroy"
        } else {
            "claude"
        };
    let initial_seed = if retained_fresh {
        "closed-native-fresh-create"
    } else {
        "closed-native-terminal-create"
    };
    let initial_soul = if retained_fresh {
        format!(
            "soul-fresh-{source_provider}-{}",
            &format!("{:x}", Sha256::digest(initial_seed.as_bytes()))[..32]
        )
    } else {
        format!(
            "soul-terminal-{}",
            &format!("{:x}", Sha256::digest(initial_seed.as_bytes()))[..32]
        )
    };
    let source_identity = qualify_private_source_reader(
        &client,
        SoulId::parse(initial_soul).unwrap(),
        if retained_fresh {
            source_provider
        } else {
            "claude"
        },
        initial_seed,
        &workspace,
        if retained_fresh {
            freshell_platform::claude_inputs::NativeSourceRuntime::Sdk
        } else {
            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal
        },
    )
    .await;
    let cwd = if changed_git {
        workspace.join("source-observer/nested")
    } else {
        workspace.clone()
    }
    .to_str()
    .unwrap()
    .to_string();
    let ambient_home = fixture.join("ambient-home");
    std::fs::create_dir_all(ambient_home.join(".claude")).unwrap();
    std::fs::write(
        ambient_home.join(".claude/CLAUDE.md"),
        "@missing-ambient-decoy.md\n",
    )
    .unwrap();
    std::env::set_var("HOME", &ambient_home);
    async fn consumed(path: &Path) -> Option<Value> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .ok()
    }
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let expected = json!({"finalExecProfile":native_exec_profile(),"hook":true,"physicalHome":"/home/freshell/provider","nativeIdentity":source_identity,"settings":true,"authenticated":true,"scopedAlias":true,"onecli":true,"refreshStageAbsent":true,"memory":hash(&memory),"skill":hash(std::fs::read(plugin.join("skills/probe/SKILL.md")).unwrap().as_slice()),"resource":hash(b"closed-claude-resource"),"diskResource":hash(&disk_resource),"dependency":hash(b"closed-claude-dependency")});
    let imported_bytes = std::fs::read(home.join("imported-memory.md")).unwrap();
    let mut expected_imports = serde_json::Map::new();
    expected_imports.insert("imported-memory.md".into(), json!(hash(&imported_bytes)));
    expected_imports.insert(
        "rule-memory.md".into(),
        json!(hash(b"closed-selected-rule-memory\n")),
    );
    for name in [
        "relative-memory.md",
        "home-memory.md",
        "absolute-memory.md",
        "spaced memory.md",
        "nested-memory.md",
    ] {
        expected_imports.insert(
            name.into(),
            json!(hash(std::fs::read(plugin.join(name)).unwrap().as_slice())),
        );
    }
    let expected_imports = Value::Object(expected_imports);
    let instructions_events = instructions_receipt.with_extension("json.events");
    fn instruction_events(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("complete native instruction event"))
            .collect()
    }
    async fn imported_graph(path: &Path, expected: &Value) {
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let mut loaded = serde_json::Map::new();
                for event in instruction_events(path) {
                    assert_ne!(
                        event["ignored"],
                        json!(true),
                        "native code spans/fences/quoted tokens must remain unselected"
                    );
                    if let Some(name) = event["selected"]["name"].as_str() {
                        loaded.insert(name.into(), event["selected"]["digest"].clone());
                    }
                }
                if Value::Object(loaded.clone()) == *expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await;
        assert!(
            result.is_ok(),
            "native must load the complete original-form Markdown import graph; observed {:?}",
            instruction_events(path)
        );
    }
    let qualified_digest = hash(
        serde_json::to_vec(&json!({"startup":expected,"nativeImports":expected_imports,"terminalSettingSources":"user","disabledProjectConsumed":false,"freshSettingSources":"user,project,local"}))
            .unwrap()
            .as_slice(),
    );
    let terminal = if retained_fresh {
        None
    } else {
        Some(controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "claude".into(),
                args: vec![
                    "--init-only".into(),
                    "--setting-sources".into(),
                    if changed_git { "user,local" } else { "user" }.into(),
                    // Native chooses the last selector. Neither an unavailable
                    // earlier file nor its private inline document is selected.
                    "--settings".into(),
                    "missing-ignored-settings.json".into(),
                    "--settings={\"env\":{\"CLAUDE_SELECTED_NONCE\":\"ignored-settings-sentinel\"}}".into(),
                    "--settings".into(),
                    flag_argument,
                    "--plugin-dir".into(),
                    plugin.to_str().unwrap().into(),
                ],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd.clone()),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::from([
                ("HOME".into(), home.to_str().unwrap().into()),
                ("CLAUDE_CONFIG_DIR".into(), if changed_git { selected_config.to_str().unwrap().into() } else { "../source-home/selected-config".into() }),
            ]),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "claude".into(),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await)
    };
    if changed_git {
        let error = terminal
            .unwrap()
            .expect_err("actual final source mismatch must block terminal startup");
        println!(
            "provider_source_guard_diagnostic {}",
            json!({"selectionChanged":error.contains("Claude native source selection changed"),"commonDir":error.contains("git common dir"),"hostUnreachable":error.contains("host") })
        );
        assert!(
            error.contains("Claude native source selection changed"),
            "final native source mismatch must be the cause, not a fixture or preparation failure"
        );
        fn unconsumed_host(handoff: &Path, route: &str, receipt: &Path) {
            let runtime =
                std::fs::read_to_string(handoff.join(format!("source-guard-{route}.state")))
                    .unwrap();
            let state: Value = serde_json::from_slice(
                &std::fs::read(Path::new(&runtime).join("host-state.json")).unwrap(),
            )
            .unwrap();
            assert!(state["grantId"].is_null());
            assert!(state["workerPid"].is_null());
            assert_eq!(state["workerLaunchCount"], json!(0));
            assert!(!receipt.exists(), "no native startup consumer may execute");
            println!(
                "provider_source_guard {}",
                json!({"provider":"claude","route":route,"grantUnconsumed":true,"workerLaunchCount":0,"nativeNotStarted":true})
            );
        }
        let handoff = fixture.join("handoff");
        unconsumed_host(&handoff, "terminal", &receipt);
        std::fs::remove_dir(Path::new(&cwd).join(".git")).unwrap();
        // These owned terminal-only decoys are outside the fresh route's
        // intended selection; remove them exactly as in the positive case.
        std::fs::remove_file(&disabled_project_memory).unwrap();
        std::fs::remove_file(&disabled_project_settings).unwrap();
        let (broadcast, _) = tokio::sync::broadcast::channel(256);
        let mut events = broadcast.subscribe();
        std::env::set_var("HOME", &home);
        let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
            Some(client.clone()),
            Arc::new(broadcast),
        )
        .unwrap()
        .unwrap();
        let flavor = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_FLAVOR").unwrap();
        let source_provider = if flavor == "kilroy" {
            "kilroy"
        } else {
            "claude"
        };
        qualify_private_source_reader(
            &client,
            SoulId::parse(format!(
                "soul-fresh-{source_provider}-{}",
                &format!("{:x}", Sha256::digest(b"closed-native-fresh-create"))[..32]
            ))
            .unwrap(),
            source_provider,
            "closed-native-fresh-create",
            &workspace,
            freshell_platform::claude_inputs::NativeSourceRuntime::Sdk,
        )
        .await;
        Arc::clone(&proxy).dispatch(HostedFreshAgentCommand::Create(serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":flavor,"provider":"claude","cwd":cwd,"plugins":[plugin.to_str().unwrap()]})).unwrap())).await;
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let frame: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
                assert_ne!(frame["type"], json!("freshAgent.created"));
                if frame["type"] == "freshAgent.create.failed" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(
            failure_classes
                .lock()
                .unwrap()
                .contains(&"Claude native source selection changed"),
            "fresh failure must come from the actual final native source selection check"
        );
        unconsumed_host(&handoff, "fresh", &receipt);
        std::fs::remove_dir(Path::new(&cwd).join(".git")).unwrap();
        assert_eq!(std::fs::read(&flag_settings).unwrap(), flag_bytes);
        assert_eq!(std::fs::read_link(&flag_alias).unwrap(), flag_settings);
        assert!(!flag_receipt.exists());
        assert!(!instructions_receipt.exists());
        web_task.abort();
        control_task.abort();
        assert!(web_task.await.unwrap_err().is_cancelled());
        assert!(control_task.await.unwrap_err().is_cancelled());
        return;
    }
    if let Some(terminal) = terminal {
        let terminal = terminal.expect("complete native Claude terminal startup");
        let observed = consumed(&receipt).await;
        if observed.is_none() {
            let output = client
                .read_output(
                    SoulId::parse(terminal.soul_id.clone()).unwrap(),
                    0,
                    64 * 1024,
                )
                .await
                .unwrap();
            let text = output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>();
            let text = crate::ai_title::strip_ansi(&text);
            let classes = [
                "ENOENT",
                "EACCES",
                "trust",
                "Trust",
                "onboarding",
                "Sign in",
                "API key",
                "plugin",
                "Plugin",
                "settings",
                "MCP",
                "Permission denied",
                "text style",
                "theme",
                "Theme",
                "Welcome",
                "Let's",
                "Enter",
                "Continue",
                "terms",
                "Token",
                "Authentication",
                "Setup",
                "select",
                "Select",
            ]
            .into_iter()
            .filter(|class| text.contains(class))
            .collect::<Vec<_>>();
            println!(
                "provider_launch_diagnostic {}",
                json!({"provider":"claude","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
            );
            let failure = std::fs::read(format!(
                "{}.profile-failure.json",
                receipt.to_str().unwrap()
            ))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            println!(
                "provider_native_profile_diagnostic {}",
                json!({"observed":failure.is_some(),"failure":failure})
            );
        }
        assert_eq!(
            observed.expect("native Claude selected plugin must execute its startup hook"),
            expected
        );
        if settings_form == "owned-last" {
            assert!(
                !flag_receipt.exists(),
                "ignored user settings hooks must not execute"
            );
        } else {
            assert_eq!(
                consumed(&flag_receipt)
                    .await
                    .expect("native must execute the explicitly selected last flag settings hook"),
                json!({"flag":true,"resource":hash(b"closed-claude-resource"),"dependency":hash(b"closed-claude-dependency")})
            );
        }
        assert_eq!(std::fs::read(&flag_settings).unwrap(), flag_bytes);
        assert_eq!(
            std::fs::read_to_string(selected_config.join("rules/nested/policy.md")).unwrap(),
            rule
        );
        assert_eq!(std::fs::read_link(&flag_alias).unwrap(), flag_settings);
        let native_import = consumed(&instructions_receipt).await;
        if native_import.is_none() {
            println!(
                "provider_memory_diagnostic {}",
                json!({"route":"terminal","hookEvents":std::fs::read_to_string(instructions_receipt.with_extension("json.events")).unwrap_or_default().lines().filter_map(|line|serde_json::from_str::<Value>(line).ok()).collect::<Vec<_>>() })
            );
        }
        assert_eq!(
            native_import.expect("native Claude must load selected memory import"),
            json!({"nativeImport":true,"digest":hash(&imported_bytes)})
        );
        imported_graph(&instructions_events, &expected_imports).await;
        println!(
            "provider_launch_consumer {}",
            json!({"provider":"claude","route":"terminal","finalExecProfile":native_exec_profile(),"digest":qualified_digest})
        );
        if std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_SOURCE_GUARD").as_deref()
            == Ok("retained")
        {
            let soul = SoulId::parse(terminal.soul_id.clone()).unwrap();
            let prior = registry.active_handle_for_soul(soul.clone()).await.unwrap();
            let prior_generation = prior
                .terminal()
                .unwrap()
                .provider_launch_context
                .as_ref()
                .unwrap()
                .prepared_inputs
                .as_ref()
                .unwrap()
                .generation_id
                .clone();
            let real = DockerEngineBackend::new(fixture.join("broker.sock"));
            real.force_stop(&prior)
                .await
                .expect("stop only the registry-owned disposable runtime");
            assert!(real.verify_empty(&prior).await.unwrap());
            let hidden_home = fixture.join("source-home-unavailable");
            std::fs::rename(&home, &hidden_home).unwrap();
            for path in [&receipt, &instructions_receipt, &instructions_events] {
                std::fs::remove_file(path).unwrap();
            }
            if settings_form != "owned-last" {
                std::fs::remove_file(&flag_receipt).unwrap();
            }
            let recovered = tokio::time::timeout(
                Duration::from_secs(120),
                client.recover(soul.clone(), RecoveryTrigger::HostUnreachable),
            )
            .await
            .expect("finite actual retained recovery")
            .expect("authenticated supervisor recovery reply");
            println!(
                "provider_recovery_outcome {}",
                json!({"outcome":recovered.outcome,"priorGeneration":prior_generation,"probe":recovered.probe.as_ref().map(|probe|match probe { RecoveryProbe::ResumeReady {..} => "native_resume", RecoveryProbe::PristineSeedReady {..} => "pristine_seed", _ => "other" })})
            );
            if let Some(RecoveryProbe::Blocked {
                reason, retry_hint, ..
            }) = &recovered.probe
            {
                let repair = retry_hint.repair.as_deref().unwrap_or("");
                let classes = [
                    "Claude",
                    "source",
                    "selection",
                    "changed",
                    "observation",
                    "identity",
                    "frozen",
                    "ordinary",
                    "manifest",
                    "metadata",
                    "HOME",
                    "scope",
                    "grant",
                    "missing",
                    "unavailable",
                    "reprepare",
                    "budget",
                    "native",
                    "store",
                    "provider",
                    "callback",
                    "checkpoint",
                    "permission",
                    "configuration",
                    "revision",
                ]
                .into_iter()
                .filter(|class| repair.contains(class))
                .collect::<Vec<_>>();
                println!(
                    "provider_recovery_diagnostic {}",
                    json!({"reason":reason,"repairClasses":classes,"repairBytes":repair.len(),"callbackFailureClasses":failure_classes.lock().unwrap().clone()})
                );
            }
            assert_eq!(recovered.outcome, RecoveryOutcome::Replaced, "actual retained callback must replace the stopped owned runtime after original ordinary inputs disappear");
            let current = registry.active_handle_for_soul(soul).await.unwrap();
            let generation = &current
                .terminal()
                .unwrap()
                .provider_launch_context
                .as_ref()
                .unwrap()
                .prepared_inputs
                .as_ref()
                .unwrap()
                .generation_id;
            assert_ne!(generation, &prior_generation);
            assert_eq!(current.provider_volume_name(), prior.provider_volume_name());
            assert_eq!(
                consumed(&receipt)
                    .await
                    .expect("recovered real native startup hook"),
                expected
            );
            if settings_form != "owned-last" {
                assert_eq!(
                    consumed(&flag_receipt)
                        .await
                        .expect("recovered explicitly selected settings hook"),
                    json!({"flag":true,"resource":hash(b"closed-claude-resource"),"dependency":hash(b"closed-claude-dependency")})
                );
            }
            imported_graph(&instructions_events, &expected_imports).await;
            assert!(!home.exists());
            println!(
                "provider_recovery_consumer {}",
                json!({"provider":"claude","route":"terminal","digest":qualified_digest,"sameOwnedHome":true,"priorGeneration":prior_generation,"generationId":generation,"originalOrdinaryUnavailable":true,"outcome":recovered.outcome})
            );
            std::fs::rename(&hidden_home, &home).unwrap();
        }
        client
            .stop(SoulId::parse(terminal.soul_id).unwrap())
            .await
            .unwrap();
        assert!(instruction_events(&instructions_events)
            .iter()
            .all(|event| event["ignored"] != json!(true)));
        assert!(
            instruction_events(&instructions_events)
                .iter()
                .all(|event| event["project"] != json!(true)),
            "the real native terminal must leave project memory unselected"
        );
        assert_eq!(
            std::fs::read_to_string(&disabled_project_memory).unwrap(),
            "@missing-disabled-project.md\n"
        );
        if source_guard == "retained" {
            // This closed scenario spends its two runtime attempts on the original
            // terminal and its replacement. The unchanged scenario below retains
            // its independent terminal and fresh SDK coverage.
            web_task.abort();
            control_task.abort();
            assert!(web_task.await.unwrap_err().is_cancelled());
            assert!(control_task.await.unwrap_err().is_cancelled());
            return;
        }
    }
    // Fresh SDK exposes the existing all-source default. Remove only these
    // terminal-specific owned decoys before its independent launch.
    std::fs::remove_file(&disabled_project_memory).unwrap();
    std::fs::remove_file(&disabled_project_settings).unwrap();
    if !retained_fresh {
        std::fs::remove_file(&receipt).unwrap();
        std::fs::remove_file(&instructions_receipt).unwrap();
        std::fs::remove_file(&instructions_events).unwrap();
    }
    // Native project command discovery stops at this repository root. A
    // dangling ancestor command root is deliberately outside that selection.
    std::fs::create_dir_all(fixture.join(".claude")).unwrap();
    std::os::unix::fs::symlink(
        "missing-unselected-command-root",
        fixture.join(".claude/commands"),
    )
    .unwrap();
    let project_commands = workspace.join(".claude/commands");
    std::fs::create_dir_all(project_commands.join("scripts/node_modules/probe-dependency"))
        .unwrap();
    std::fs::write(project_commands.join("closed-project-command.md"), "---\ndescription: selected project command transport\n---\nUse the adjacent synthetic resources.\n").unwrap();
    std::fs::write(
        project_commands.join("scripts/resource"),
        "closed-project-command-resource",
    )
    .unwrap();
    std::fs::write(
        project_commands.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-project-command-dependency'",
    )
    .unwrap();
    std::fs::write(
        project_commands.join("scripts/run"),
        "#!/bin/sh\ncat \"$(dirname \"$0\")/resource\"\n",
    )
    .unwrap();
    std::fs::set_permissions(
        project_commands.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let project_receipt = workspace.join("claude-project-command-consumed.json");
    std::fs::write(project_commands.join("scripts/consume.cjs"), "const fs=require('node:fs'),crypto=require('node:crypto');const hash=v=>crypto.createHash('sha256').update(v).digest('hex');fs.writeFileSync(process.argv[2],JSON.stringify({resource:hash(require('node:child_process').execFileSync(__dirname+'/run')),dependency:hash(require('probe-dependency'))}));").unwrap();
    let mut project_settings: Value = serde_json::from_str(settings).unwrap();
    project_settings["hooks"] = json!({"SessionStart":[{"hooks":[{"type":"command","command":format!("node {} {}",serde_json::to_string(project_commands.join("scripts/consume.cjs").to_str().unwrap()).unwrap(),serde_json::to_string(project_receipt.to_str().unwrap()).unwrap()),"timeout":10}]}]});
    std::fs::write(
        workspace.join(".claude/settings.json"),
        serde_json::to_vec(&project_settings).unwrap(),
    )
    .unwrap();
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    std::env::set_var("HOME", &home);
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    let flavor = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_FLAVOR").unwrap();
    assert!(matches!(flavor.as_str(), "freshclaude" | "kilroy"));
    let source_provider = if flavor == "kilroy" {
        "kilroy"
    } else {
        "claude"
    };
    let fresh_identity = if retained_fresh {
        source_identity.clone()
    } else {
        qualify_private_source_reader(
            &client,
            SoulId::parse(format!(
                "soul-fresh-{source_provider}-{}",
                &format!("{:x}", Sha256::digest(b"closed-native-fresh-create"))[..32]
            ))
            .unwrap(),
            source_provider,
            "closed-native-fresh-create",
            &workspace,
            freshell_platform::claude_inputs::NativeSourceRuntime::Sdk,
        )
        .await
    };
    assert_eq!(
        fresh_identity, source_identity,
        "both actual source readers must match the real native consumer identity"
    );
    Arc::clone(&proxy).dispatch(HostedFreshAgentCommand::Create(serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":flavor,"provider":"claude","cwd":cwd,"plugins":[plugin.to_str().unwrap()]})).unwrap())).await;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let frame: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                println!("provider_launch_failure_classes {}", json!({"provider":"claude","flavor":flavor,"classes":failure_classes.lock().unwrap().clone()}));
                panic!("fresh Claude startup failed; only the safe failure classes are reported");
            }
            if frame["type"] == "freshAgent.created" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        consumed(&receipt)
            .await
            .expect("genuine default SDK selected plugin must execute its startup hook"),
        expected
    );
    assert_eq!(
        consumed(&instructions_receipt)
            .await
            .expect("native default SDK must load selected memory import"),
        json!({"nativeImport":true,"digest":hash(&imported_bytes)})
    );
    imported_graph(&instructions_events, &expected_imports).await;
    assert_eq!(consumed(&project_receipt).await.expect("native selected project command hook must execute its complete resource and installed dependency"), json!({"resource":hash(b"closed-project-command-resource"),"dependency":hash(b"closed-project-command-dependency")}));
    assert_eq!(
        std::fs::read_link(fixture.join(".claude/commands")).unwrap(),
        Path::new("missing-unselected-command-root")
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"claude","route":"fresh","finalExecProfile":native_exec_profile(),"digest":qualified_digest})
    );
    assert_eq!(
        std::fs::read_to_string(selected_config.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("scripts/consume.cjs")).unwrap(),
        consumer
    );
    if retained_fresh {
        let soul = SoulId::parse(format!(
            "soul-fresh-{source_provider}-{}",
            &format!("{:x}", Sha256::digest(b"closed-native-fresh-create"))[..32]
        ))
        .unwrap();
        let prior = registry.active_handle_for_soul(soul.clone()).await.unwrap();
        let prior_generation = prior
            .fresh_agent()
            .unwrap()
            .provider_launch_context
            .as_ref()
            .unwrap()
            .prepared_inputs
            .as_ref()
            .unwrap()
            .generation_id
            .clone();
        let real = DockerEngineBackend::new(fixture.join("broker.sock"));
        real.force_stop(&prior)
            .await
            .expect("stop only the registry-owned disposable SDK runtime");
        assert!(real.verify_empty(&prior).await.unwrap());
        let hidden_home = fixture.join("source-home-unavailable");
        std::fs::rename(&home, &hidden_home).unwrap();
        for path in [
            &receipt,
            &instructions_receipt,
            &instructions_events,
            &project_receipt,
        ] {
            std::fs::remove_file(path).unwrap();
        }
        let recovered = tokio::time::timeout(
            Duration::from_secs(120),
            client.recover(soul.clone(), RecoveryTrigger::HostUnreachable),
        )
        .await
        .expect("finite actual retained SDK recovery")
        .expect("authenticated supervisor recovery reply");
        println!(
            "provider_recovery_outcome {}",
            json!({"outcome":recovered.outcome,"priorGeneration":prior_generation,"probe":recovered.probe.as_ref().map(|probe|match probe {RecoveryProbe::ResumeReady {..} => "native_resume", RecoveryProbe::PristineSeedReady {..} => "pristine_seed", _ => "other"}),"callbackFailureClasses":failure_classes.lock().unwrap().clone()})
        );
        if let Some(RecoveryProbe::Blocked {
            reason, retry_hint, ..
        }) = &recovered.probe
        {
            let repair = retry_hint.repair.as_deref().unwrap_or("");
            let classes = [
                "Claude",
                "source",
                "selection",
                "changed",
                "observation",
                "identity",
                "frozen",
                "ordinary",
                "manifest",
                "metadata",
                "HOME",
                "scope",
                "grant",
                "missing",
                "unavailable",
                "reprepare",
                "budget",
                "native",
                "store",
                "provider",
                "callback",
                "checkpoint",
                "permission",
                "configuration",
                "revision",
                "healthy",
                "host",
                "worker",
                "activation",
                "ready",
                "timed out",
            ]
            .into_iter()
            .filter(|class| repair.contains(class))
            .collect::<Vec<_>>();
            println!(
                "provider_recovery_diagnostic {}",
                json!({"reason":reason,"repairClasses":classes,"repairBytes":repair.len()})
            );
        }
        assert_eq!(recovered.outcome, RecoveryOutcome::Replaced, "actual retained SDK callback must replace the stopped owned runtime after original ordinary inputs disappear");
        assert!(
            matches!(
                recovered.probe,
                Some(RecoveryProbe::PristineSeedReady { .. })
            ),
            "empty SDK fixture must use the actual pristine seed recovery path"
        );
        let current = registry.active_handle_for_soul(soul).await.unwrap();
        let generation = &current
            .fresh_agent()
            .unwrap()
            .provider_launch_context
            .as_ref()
            .unwrap()
            .prepared_inputs
            .as_ref()
            .unwrap()
            .generation_id;
        assert_ne!(generation, &prior_generation);
        assert_eq!(current.provider_volume_name(), prior.provider_volume_name());
        assert_eq!(
            consumed(&receipt)
                .await
                .expect("recovered genuine SDK startup hook"),
            expected
        );
        assert_eq!(
            consumed(&instructions_receipt)
                .await
                .expect("recovered SDK native memory import"),
            json!({"nativeImport":true,"digest":hash(&imported_bytes)})
        );
        imported_graph(&instructions_events, &expected_imports).await;
        assert_eq!(
            consumed(&project_receipt)
                .await
                .expect("recovered SDK current project command hook"),
            json!({"resource":hash(b"closed-project-command-resource"),"dependency":hash(b"closed-project-command-dependency")})
        );
        assert!(!home.exists());
        println!(
            "provider_recovery_consumer {}",
            json!({"provider":"claude","route":"fresh","digest":qualified_digest,"sameOwnedHome":true,"priorGeneration":prior_generation,"generationId":generation,"originalOrdinaryUnavailable":true,"outcome":recovered.outcome})
        );
        std::fs::rename(&hidden_home, &home).unwrap();
    }
    let catalog_project = fixture.join("catalog-project");
    let catalog_home = fixture.join("catalog-home");
    std::fs::create_dir_all(catalog_project.join(".git")).unwrap();
    std::fs::create_dir_all(&catalog_home).unwrap();
    let mut catalog_owners = 0;
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running && view.launch_state == LaunchState::Running
        {
            let handle = registry
                .active_handle_for_soul(view.soul_id.clone())
                .await
                .unwrap();
            assert_eq!(handle.incarnation_id(), &view.incarnation_id);
            catalog_owners += 1;
            let inputs = handle
                .fresh_agent()
                .unwrap()
                .provider_launch_context
                .as_ref()
                .unwrap()
                .prepared_inputs
                .as_ref()
                .unwrap();
            let commands = inputs.resource_mounts.iter().find(|mount| Path::new(&mount.logical_destination) == project_commands).expect("accepted native project command root must be present in the complete preparation");
            // The hosted SDK intentionally defers publishing its prefetched
            // catalog until system/init. With no model turn, consume the real
            // native supportedCommands API separately over this accepted copy.
            // Stop the hosted process first to avoid overlapping native workers.
            freshell_platform::provider_environment::copy_environment(
                &[freshell_platform::provider_environment::CopySelection {
                    source: control
                        .join("provider-roots")
                        .join(&inputs.generation_id)
                        .join(&commands.stage_relative_path),
                    destination_relative: ".claude/commands".into(),
                }],
                &catalog_project,
                &[],
                freshell_platform::provider_environment::CopyLimits::default(),
            )
            .unwrap();
            client.stop(view.soul_id).await.unwrap();
        }
    }
    assert_eq!(
        catalog_owners, 1,
        "catalog must consume exactly the active SDK preparation"
    );
    let catalog_script = fixture.join("catalog-probe.mjs");
    std::fs::write(&catalog_script, r#"import {query} from '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const abort = new AbortController();
async function* emptyPrompt() { await new Promise(resolve => abort.signal.addEventListener('abort', resolve, {once:true})); }
let q;
try {
 q=query({prompt:emptyPrompt(),options:{abortController:abort,cwd:process.argv[2],settingSources:['project'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:process.argv[3],CLAUDE_CONFIG_DIR:process.argv[3]+'/.claude',ANTHROPIC_API_KEY:'synthetic-catalog-only',ANTHROPIC_BASE_URL:'http://127.0.0.1:9'}}});
 const commands=await q.supportedCommands();process.stdout.write(JSON.stringify({selected:commands.some(command=>command.name==='closed-project-command')}));
} catch(error) {
 const message=String(error?.message||'');
 const classes=['EROFS','EACCES','ENOENT','Native CLI binary','spawn node','process exited','AbortError'].filter(value=>message.includes(value));
 process.stdout.write(JSON.stringify({failed:true,classes}));process.exitCode=1;
} finally { q?.close();abort.abort(); }
"#).unwrap();
    let catalog_output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new("node")
            .kill_on_drop(true)
            .arg(&catalog_script)
            .arg(&catalog_project)
            .arg(&catalog_home)
            .output(),
    )
    .await
    .expect("owned model-free native catalog probe deadline")
    .unwrap();
    if !catalog_output.status.success() {
        let stderr = String::from_utf8_lossy(&catalog_output.stderr);
        let probe = serde_json::from_slice::<Value>(&catalog_output.stdout).ok();
        let classes: Vec<_> = [
            "ERR_MODULE_NOT_FOUND",
            "EACCES",
            "ENOENT",
            "AbortError",
            "close is not a function",
            "uv_thread_create",
            "SIGABRT",
            "Claude Code process exited",
            "Unexpected token",
        ]
        .into_iter()
        .filter(|class| stderr.contains(class))
        .collect();
        println!(
            "provider_catalog_diagnostic {}",
            json!({"code":catalog_output.status.code(),"stderrBytes":catalog_output.stderr.len(),"stdoutBytes":catalog_output.stdout.len(),"classes":classes,"caughtClasses":probe.as_ref().and_then(|value|value.get("classes")),"selectedWritten":catalog_output.stdout.windows(b"\"selected\":true".len()).any(|bytes|bytes==b"\"selected\":true")})
        );
    }
    assert!(
        catalog_output.status.success(),
        "genuine SDK catalog probe must complete without a model turn"
    );
    assert_eq!(serde_json::from_slice::<Value>(&catalog_output.stdout).unwrap(), json!({"selected":true}), "the genuine default SDK must discover the selected project command through native bounded directory search");
    assert!(instruction_events(&instructions_events)
        .iter()
        .all(|event| event["ignored"] != json!(true)));
    web_task.abort();
    control_task.abort();
    assert!(web_task.await.unwrap_err().is_cancelled());
    assert!(control_task.await.unwrap_err().is_cancelled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_codex_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE")
            .expect("run the closed --provider-launches --provider codex sandbox"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let workspace = fixture.join("workspace");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    let skill = home.join(".codex/skills/probe");
    for path in [
        &control,
        &runtime,
        &skill.join("scripts/node_modules/probe-dependency"),
        &workspace.join(".codex/agents"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    std::fs::write(skill.join("SKILL.md"), "---\nname: transport-probe\ndescription: complete launch fixture\n---\nExecute the adjacent synthetic resource.\n").unwrap();
    std::fs::write(skill.join("scripts/resource"), b"closed-codex-resource").unwrap();
    std::fs::write(
        skill.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-codex-dependency'\n",
    )
    .unwrap();
    std::fs::write(
        skill.join("scripts/run"),
        "#!/bin/sh\ncat \"$(dirname \"$0\")/resource\"\n",
    )
    .unwrap();
    std::fs::set_permissions(
        skill.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let receipt = workspace.join("codex-consumed.json");
    let server = r#"const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),path=require('node:path');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const readline=require('node:readline').createInterface({input:process.stdin});
readline.on('line',async line=>{let message;try{message=JSON.parse(line)}catch{return}if(message.id===undefined)return;
let result={};if(message.method==='initialize'){
 const endpoint=process.env.FRESHELL_URL,token=process.env.FRESHELL_TOKEN;
 const authenticated=await new Promise(resolve=>{if(!endpoint||!token)return resolve(false);const req=http.request(new URL('/api/mcp',endpoint),{method:'POST',headers:{'x-auth-token':token}},res=>{res.resume();resolve(res.statusCode===200)});req.on('error',()=>resolve(false));req.end('{}')});
 const nativeArgv=fs.readFileSync('/proc/'+process.ppid+'/cmdline','utf8').split('\0');
 const retainedMcpRecipe=nativeArgv.includes('mcp_servers.freshell.command="node"')&&nativeArgv.includes('mcp_servers.freshell.args=["/opt/freshell-mcp/server.js"]')&&nativeArgv.some(arg=>arg.startsWith('mcp_servers.freshell.env_vars='));
 const policy=JSON.parse(require('node:child_process').execFileSync('codex',['execpolicy','check','--rules',path.join(process.env.CODEX_HOME,'rules/probe.rules'),'closed-fixture-never-run'],{encoding:'utf8'}));
 const record={finalExecProfile:nativeExecProfile('parent'),globalInstructions:digest(fs.readFileSync(path.join(process.env.CODEX_HOME,'AGENTS.md'))),nativeRuleForbidden:policy.decision==='forbidden',physicalHome:process.env.HOME,initialized:true,authenticated,retainedMcpRecipe,scopedAlias:process.env.FRESHELL==='1',endpointPresent:!!endpoint,tokenPresent:!!token,
   user:digest(fs.readFileSync(path.join(process.env.CODEX_HOME,'user.md'))),project:digest(fs.readFileSync(path.join(process.cwd(),'.codex/project.md'))),
   role:digest(fs.readFileSync(path.join(process.cwd(),'.codex/agents/role.md'))),skill:digest(fs.readFileSync(path.join(__dirname,'../SKILL.md'))),
   resource:digest(require('node:child_process').execFileSync(path.join(__dirname,'run'))),dependency:digest(require('probe-dependency'))};
 fs.writeFileSync(process.argv[2],JSON.stringify(record));result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'closed-managed-source-consumer',version:'1'}};
}else if(message.method==='tools/list')result={tools:[]};else if(message.method==='resources/list')result={resources:[]};else if(message.method==='prompts/list')result={prompts:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');});
"#;
    std::fs::write(
        skill.join("scripts/server.cjs"),
        format!("{NATIVE_EXEC_PROFILE}{server}"),
    )
    .unwrap();
    let plugin = home.join(".codex/plugins/cache/fixture/probe/local");
    let plugin_data_name = format!("{:x}", Sha256::digest(b"fixture\0probe"));
    let plugin_data = home
        .join(".codex/plugins/data/agent-plugins")
        .join(&plugin_data_name);
    let plugin_receipt = workspace.join("codex-installed-consumed.json");
    std::fs::create_dir_all(plugin.join("scripts/node_modules/probe-dependency")).unwrap();
    std::fs::create_dir_all(&plugin_data).unwrap();
    std::fs::write(plugin.join("plugin.json"), r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"probe"}"#).unwrap();
    std::fs::write(
        plugin.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-installed-plugin-dependency'",
    )
    .unwrap();
    std::fs::write(plugin_data.join("nonce"), b"closed-hashed-plugin-resource").unwrap();
    std::fs::write(plugin.join("scripts/server.cjs"), r#"const fs=require('node:fs'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 let message;try{message=JSON.parse(line)}catch{return}if(message.id===undefined)return;
 let result={};if(message.method==='initialize'){
  const record={initialized:true,data:digest(fs.readFileSync(process.argv[2])),dependency:digest(require('probe-dependency')),
   dataIdentity:process.env.PLUGIN_DATA.endsWith('/plugins/data/agent-plugins/'+process.argv[4]),
   dataCwd:process.cwd()===process.env.PLUGIN_DATA,root:process.env.PLUGIN_ROOT==='/home/freshell/provider/.codex/plugins/cache/fixture/probe/local'};
  fs.writeFileSync(process.argv[3],JSON.stringify(record));
  result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'closed-installed-data-consumer',version:'1'}};
 }else if(message.method==='tools/list')result={tools:[]};else if(message.method==='resources/list')result={resources:[]};else if(message.method==='prompts/list')result={prompts:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
});
"#).unwrap();
    std::fs::write(plugin.join("mcp.json"), serde_json::to_vec(&json!({
        "$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers":{"data-probe":{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/scripts/server.cjs","${PLUGIN_DATA}/nonce",plugin_receipt,plugin_data_name],"cwd":"${PLUGIN_DATA}"}}
    })).unwrap()).unwrap();
    std::fs::create_dir_all(home.join(".codex/rules")).unwrap();
    std::fs::write(home.join(".codex/AGENTS.md"), b"closed-global-instructions").unwrap();
    std::fs::write(
        home.join(".codex/rules/probe.rules"),
        "prefix_rule(pattern=['closed-fixture-never-run'], decision='forbidden')\n",
    )
    .unwrap();
    let config = format!("model='synthetic-model'\nmodel_provider='fixture'\nmodel_instructions_file='./user.md'\n[model_providers.fixture]\nname='Closed fixture'\nbase_url='http://127.0.0.1:9'\nwire_api='responses'\nrequires_openai_auth=false\n[projects.{}]\ntrust_level='trusted'\n[mcp_servers.probe]\ncommand='node'\nenv_vars=['FRESHELL_URL','FRESHELL_TOKEN','FRESHELL','CODEX_HOME']\nargs=[{},{}]\n", serde_json::to_string(workspace.to_str().unwrap()).unwrap(), serde_json::to_string(skill.join("scripts/server.cjs").to_str().unwrap()).unwrap(), serde_json::to_string(receipt.to_str().unwrap()).unwrap());
    let config = format!("{config}[features]\nplugins=true\n[plugins.\"probe@fixture\"]\n");
    std::fs::write(home.join(".codex/config.toml"), &config).unwrap();
    std::fs::write(home.join(".codex/user.md"), b"closed-user-input").unwrap();
    let project_config = "model_instructions_file='./project.md'\n[agents.worker]\nconfig_file='./agents/worker.toml'\n";
    std::fs::write(workspace.join(".codex/config.toml"), project_config).unwrap();
    std::fs::write(workspace.join(".codex/project.md"), b"closed-project-input").unwrap();
    std::fs::write(workspace.join(".codex/agents/worker.toml"), "name='worker'\ndescription='synthetic role'\ndeveloper_instructions='synthetic developer'\nmodel_instructions_file='./role.md'\n").unwrap();
    std::fs::write(
        workspace.join(".codex/agents/role.md"),
        b"closed-role-input",
    )
    .unwrap();
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "codex");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(BrokerAuthorizedBackend {
            real: DockerEngineBackend::new(fixture.join("broker.sock")),
            cold_backend: Default::default(),
            control: control.clone(),
            handoff: fixture.join("handoff"),
            certificate_sentinel: b"unselected-private-sentinel".to_vec(),
        }),
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: PathBuf::from(
                std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
            ),
            image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
            test_run_id: std::env::var("FRESHELL_PROVIDER_LAUNCH_RUN_ID").unwrap(),
            control_secret: "closed-synthetic-control-secret".into(),
            lifecycle_log: fixture.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let web = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = web.local_addr().unwrap().port();
    let web_token = Arc::new("closed-synthetic-web-token".to_string());
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            web_token,
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for (name, value) in [
        ("FRESHELL_MANAGED_RUNTIME_V1", "1"),
        ("FRESHELL_MANAGED_FRESH_AGENT_V1", "1"),
    ] {
        std::env::set_var(name, value);
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = workspace.to_str().unwrap().to_owned();
    let terminal = controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "codex".into(),
                args: vec![],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd.clone()),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::new(),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "codex".into(),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await
        .expect("actual Codex controller/supervisor/session-host terminal startup");
    let client = controller.runtime_client();
    async fn consumed(path: &Path) -> Result<Value, &'static str> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .map_err(|_| "native Codex must initialize its configured MCP consumer")
    }
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let expected = json!({"finalExecProfile":native_exec_profile(),"globalInstructions":hash(b"closed-global-instructions"),"nativeRuleForbidden":true,"physicalHome":"/home/freshell/provider","initialized":true,"authenticated":true,"retainedMcpRecipe":true,"scopedAlias":true,"endpointPresent":true,"tokenPresent":true,"user":hash(b"closed-user-input"),"project":hash(b"closed-project-input"),"role":hash(b"closed-role-input"),"skill":hash(std::fs::read(skill.join("SKILL.md")).unwrap().as_slice()),"resource":hash(b"closed-codex-resource"),"dependency":hash(b"closed-codex-dependency")});
    let consumed_terminal = consumed(&receipt).await;
    if consumed_terminal.is_err() {
        let output = client
            .read_output(
                SoulId::parse(terminal.soul_id.clone()).unwrap(),
                0,
                64 * 1024,
            )
            .await
            .unwrap();
        let text = output
            .frames
            .iter()
            .map(|frame| frame.data.as_str())
            .collect::<String>();
        let classes = [
            "ERR_INVALID_ARG_TYPE",
            "ENOENT",
            "EACCES",
            "onboarding",
            "Sign in",
            "trust",
            "API key",
            "MCP",
            "mcp",
            "initialize",
            "failed",
            "Permission denied",
            "Terminal",
            "TERM",
            "user.md",
            "project.md",
            "role.md",
            "server.cjs",
            "node",
            "config.toml",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"provider":"codex","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
        );
    }
    assert_eq!(consumed_terminal.unwrap(), expected);
    let expected_plugin = json!({"initialized":true,"data":hash(b"closed-hashed-plugin-resource"),"dependency":hash(b"closed-installed-plugin-dependency"),"dataIdentity":true,"dataCwd":true,"root":true});
    assert_eq!(
        consumed(&plugin_receipt)
            .await
            .expect("native AgentPlugin MCP must consume transported hashed data"),
        expected_plugin
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"codex","route":"terminal","finalExecProfile":native_exec_profile(),"digest":hash(serde_json::to_vec(&json!({"ordinary":expected,"installed":expected_plugin})).unwrap().as_slice())})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(&plugin_receipt).unwrap();
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    Arc::clone(&proxy).dispatch(HostedFreshAgentCommand::Create(serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":"freshcodex","provider":"codex","cwd":cwd})).unwrap())).await;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let frame: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                panic!("actual fresh Codex failed: {}", frame["message"]);
            }
            if frame["type"] == "freshAgent.created" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(consumed(&receipt).await.unwrap(), expected);
    assert_eq!(
        consumed(&plugin_receipt)
            .await
            .expect("native fresh AgentPlugin MCP must consume transported hashed data"),
        expected_plugin
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"codex","route":"fresh","finalExecProfile":native_exec_profile(),"digest":hash(serde_json::to_vec(&json!({"ordinary":expected,"installed":expected_plugin})).unwrap().as_slice())})
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(),
        config
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join(".codex/config.toml")).unwrap(),
        project_config
    );
    assert_eq!(
        std::fs::read(plugin_data.join("nonce")).unwrap(),
        b"closed-hashed-plugin-resource"
    );
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    web_task.abort();
    control_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_opencode_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE")
            .expect("run the closed --provider-launches sandbox"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("fln-") && name.len() == 20));
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    for directory in [&control, &runtime, &fixture.join("handoff")] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let binary = PathBuf::from(std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap());
    let image = std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap();
    let installation =
        InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
            .unwrap();
    let registry = Registry::open(fixture.join("registry"), Some(installation)).unwrap();
    let certificate = std::fs::read_to_string(fixture.join("grants/ca.pem")).unwrap();
    let certificate_sentinel = certificate
        .lines()
        .find(|line| !line.starts_with("-----"))
        .unwrap()
        .as_bytes()
        .to_vec();
    assert!(certificate_sentinel.len() >= 32);
    let backend = Arc::new(BrokerAuthorizedBackend {
        real: DockerEngineBackend::new(fixture.join("broker.sock")),
        cold_backend: Default::default(),
        control: control.clone(),
        handoff: fixture.join("handoff"),
        certificate_sentinel: certificate_sentinel.clone(),
    });
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        backend,
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: binary,
            image_ref: image,
            test_run_id: std::env::var("FRESHELL_PROVIDER_LAUNCH_RUN_ID").unwrap(),
            control_secret: "closed-synthetic-control-secret".into(),
            lifecycle_log: fixture.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let web = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = web.local_addr().unwrap().port();
    // Native well-known authentication fetches configuration from the outer
    // auth-store key before reading local configuration. Keep that dependency
    // inside the same owned synthetic fixture as the launch consumers.
    let well_known_url = format!("http://host.docker.internal:{port}");
    let inline_auth_url = format!("{well_known_url}/inline-auth");
    std::fs::write(
        fixture.join("grants/auth.json"),
        serde_json::to_vec(&json!({well_known_url.clone(): {
            "type": "wellknown", "key": "OPENAI_API_KEY",
            "token": format!("AUTH_PREFIX{{file:{}}}AUTH_SUFFIX", fixture.join("workspace/home rule with spaces.txt").display())
        }, inline_auth_url.clone(): {"type":"wellknown","key":"INLINE_VALUE","token":"AUTH_INLINE_SHADOW_NO_FILE"}}))
        .unwrap(),
    )
    .unwrap();
    let web_task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = web.accept().await else {
                break;
            };
            {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut bytes = [0; 4096];
                let _ = stream.read(&mut bytes).await;
                let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{\"config\":{}}").await;
            }
        }
    });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    std::env::set_var("FRESHELL_MANAGED_RUNTIME_V1", "1");
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("FRESHELL_MANAGED_FRESH_AGENT_V1", "1");
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let nested = fixture.join("workspace/nested");
    std::fs::create_dir_all(&nested).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(fixture.join("workspace"))
        .status()
        .unwrap()
        .success());
    let shared_source = fixture.join("workspace/shared.json");
    let shared_receipt = fixture.join("workspace/shared-origin-consumed.json");
    let shared_home_rule = fixture.join("workspace/home rule with spaces.txt");
    std::fs::write(&shared_home_rule, "shared-home-sensitive-file\n").unwrap();
    std::fs::set_permissions(&shared_home_rule, std::fs::Permissions::from_mode(0o600)).unwrap();
    let shared_lane_receipt = fixture.join("workspace/shared-lane-consumed");
    let shared_json = serde_json::to_string(&json!({"agent":{
        "probe":{"prompt":"{env:OPENAI_API_KEY}"},
        "sharedRelative":{"prompt":"{file:./rules.txt}"},
        "sharedAbsolute":{"prompt":format!("{{file:{}}}", shared_home_rule.display())},
        "sharedHome":{"prompt":"{file:~/home rule with spaces.txt}"}
    }, "plugin":[["./shared-probe", {"receipt":shared_receipt,"laneReceipt":shared_lane_receipt,"auth":"{env:OPENAI_API_KEY}","ca":"{file:{env:NODE_EXTRA_CA_CERTS}}"}]]}))
    .unwrap();
    let shared_bytes = format!(
        "{{\n // native comment {{file:./unselected-missing}}\n{}",
        &shared_json[1..]
    )
    .into_bytes();
    for (directory, label) in [
        (fixture.join("workspace"), "root"),
        (nested.clone(), "nested"),
    ] {
        let plugin = format!(
            r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-shared-{label}',async server(input,options){{return {{async config(config){{
 let receipt=fs.existsSync(options.receipt)?JSON.parse(fs.readFileSync(options.receipt,'utf8')):{{}};
 receipt.{label}={{relative:crypto.createHash('sha256').update(fs.readFileSync(new URL('../rules.txt',import.meta.url))).digest('hex'),absolute:crypto.createHash('sha256').update(config.agent.sharedAbsolute.prompt).digest('hex'),home:crypto.createHash('sha256').update(config.agent.sharedHome.prompt).digest('hex')}};
 fs.writeFileSync(options.receipt,JSON.stringify(receipt));
 fs.writeFileSync(options.laneReceipt+'.{label}.main',JSON.stringify({{auth:crypto.createHash('sha256').update(options.auth).digest('hex'),ca:crypto.createHash('sha256').update(options.ca).digest('hex')}}));
}}}}}}}};
"#
        );
        let tui_plugin = format!(
            r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-shared-{label}',async tui(api,options){{
 fs.writeFileSync(options.laneReceipt+'.{label}.tui',JSON.stringify({{auth:crypto.createHash('sha256').update(options.auth).digest('hex'),ca:crypto.createHash('sha256').update(options.ca).digest('hex'),theme:crypto.createHash('sha256').update(api.tuiConfig.theme).digest('hex')}}));
 setTimeout(()=>{{const dir='/home/freshell/provider/.freshell/session-signals/opencode';const alive=fs.existsSync(dir)&&fs.readdirSync(dir).some(name=>name.startsWith('closed-native-terminal__')&&JSON.parse(fs.readFileSync(dir+'/'+name,'utf8')).hello===true);fs.writeFileSync(options.laneReceipt+'.{label}.rebind',JSON.stringify({{alive}}));}},1500);
}}}};
"#
        );
        let package = directory.join("shared-probe");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("server.mjs"), plugin).unwrap();
        std::fs::write(package.join("tui.mjs"), tui_plugin).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"exports":{"./server":"./server.mjs","./tui":"./tui.mjs"}}"#,
        )
        .unwrap();
    }
    std::fs::write(&shared_source, &shared_bytes).unwrap();
    std::os::unix::fs::symlink("shared.json", fixture.join("workspace/opencode.json")).unwrap();
    std::os::unix::fs::symlink("../shared.json", nested.join("opencode.json")).unwrap();
    for (path, bytes) in [
        (
            fixture.join("workspace/rules.txt"),
            b"native-shared-root-rule".as_slice(),
        ),
        (
            nested.join("rules.txt"),
            b"native-shared-nested-rule".as_slice(),
        ),
    ] {
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let cwd = nested.to_string_lossy().into_owned();
    let original_config = fixture.join("source-home/.config/opencode/opencode.json");
    // These ordinary native fields select resources outside every implicit
    // HOME, workspace and control root. The plugin needs its adjacent scope
    // and installed parent lookup, and reads the selected instruction itself.
    let external = fixture.join("scenarios/external-native-resources");
    let package = external.join("plugin-package");
    std::fs::create_dir_all(package.join("node_modules/closed-child")).unwrap();
    std::fs::create_dir_all(external.join("node_modules/closed-parent")).unwrap();
    for (base, name, value) in [
        (&package, "closed-child", "native-child-dependency"),
        (&external, "closed-parent", "native-parent-dependency"),
    ] {
        let dependency = base.join("node_modules").join(name);
        std::fs::write(
            dependency.join("package.json"),
            br#"{"type":"module","exports":"./index.mjs"}"#,
        )
        .unwrap();
        std::fs::write(
            dependency.join("index.mjs"),
            format!("export default {};", serde_json::to_string(value).unwrap()),
        )
        .unwrap();
    }
    std::fs::write(
        package.join("package.json"),
        br#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        package.join("adjacent.mjs"),
        "export default 'native-adjacent-import';",
    )
    .unwrap();
    std::fs::write(package.join("resource.txt"), "native-adjacent-resource").unwrap();
    let external_instruction = external.join("ordinary-instructions.md");
    std::fs::write(&external_instruction, "native-external-instruction").unwrap();
    let selected_skills = external.join("selected-skills");
    let selected_skill = selected_skills.join("probe");
    std::fs::create_dir_all(selected_skill.join("scripts/node_modules/skill-dependency")).unwrap();
    std::fs::write(selected_skill.join("SKILL.md"), "---\nname: closed-external-skill\ndescription: selected external skill\n---\nExecute the adjacent synthetic resources.\n").unwrap();
    std::fs::write(
        selected_skill.join("scripts/resource"),
        "native-skill-resource",
    )
    .unwrap();
    std::fs::write(
        selected_skill.join("scripts/node_modules/skill-dependency/index.js"),
        "module.exports='native-skill-dependency';",
    )
    .unwrap();
    std::fs::write(selected_skill.join("scripts/run"), "#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('skill-dependency'));\n").unwrap();
    std::fs::set_permissions(
        selected_skill.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let mcp_cwd = nested.join("~/mcp-cwd");
    std::fs::create_dir_all(fixture.join("source-home/mcp-cwd")).unwrap();
    std::fs::write(
        fixture.join("source-home/mcp-cwd/resource"),
        "wrong-home-cwd-decoy",
    )
    .unwrap();
    std::fs::create_dir_all(mcp_cwd.join("node_modules/native-mcp-dependency")).unwrap();
    std::fs::write(mcp_cwd.join("resource"), "native-mcp-resource").unwrap();
    std::fs::write(
        mcp_cwd.join("node_modules/native-mcp-dependency/index.js"),
        "module.exports='native-mcp-dependency';",
    )
    .unwrap();
    let mcp_cwd_receipt = fixture.join("workspace/native-mcp-cwd-consumed.txt");
    std::fs::write(mcp_cwd.join("server.cjs"), format!(r#"const fs=require('node:fs'),readline=require('node:readline');
fs.writeFileSync({},fs.readFileSync('resource','utf8')+':'+require('native-mcp-dependency'));
readline.createInterface({{input:process.stdin}}).on('line',line=>{{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{{protocolVersion:q.params.protocolVersion,capabilities:{{tools:{{}}}},serverInfo:{{name:'closed-cwd-probe',version:'1'}}}}:q.method==='tools/list'?{{tools:[]}}:{{}};process.stdout.write(JSON.stringify({{jsonrpc:'2.0',id:q.id,result}})+'\n');}});
"#,serde_json::to_string(&mcp_cwd_receipt).unwrap())).unwrap();
    let external_receipt = fixture.join("workspace/native-external-consumed.json");
    let external_plugin = r#"import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';import {execFileSync} from 'node:child_process';
import adjacent from './adjacent.mjs';import child from 'closed-child';import parent from 'closed-parent';
export default async (input,options)=>({config:async(config)=>{
 const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
 setTimeout(async()=>{
  try {
   const response=await input.client._client.get({url:'/skill'});
   const skill=response.data.find(skill=>skill.name==='closed-external-skill');
   if(!skill)throw Error('selected native skill unavailable');
   const output=execFileSync(path.join(path.dirname(skill.location),'scripts/run'));
   await input.client._client.get({url:'/mcp'});
   const mcp=digest(fs.readFileSync(options.mcpReceipt));
   fs.writeFileSync(options.receipt,JSON.stringify({adjacent:digest(adjacent),child:digest(child),parent:digest(parent),resource:digest(fs.readFileSync(new URL('./resource.txt',import.meta.url))),instruction:digest(fs.readFileSync(options.instruction)),selected:config.instructions.includes(options.instruction),nativeLiveViews:config.agent.liveCapacity.description==='native-live-capacity-nonce',nativeSkill:true,skillContent:digest(skill.content),skillExecution:digest(output),nativeMcpCwd:mcp}));
  } catch(error) {fs.writeFileSync(options.receipt+'.failure',JSON.stringify({operation:'native_skill_consumer',type:error instanceof TypeError?'TypeError':error.code==='ENOENT'?'ENOENT':'native_skill_unavailable'}));}
 },0);
}});
"#;
    std::fs::write(package.join("index.mjs"), external_plugin).unwrap();
    let mut original: Value =
        serde_json::from_slice(&std::fs::read(&original_config).unwrap()).unwrap();
    original["plugin"].as_array_mut().unwrap().push(json!([reqwest::Url::from_file_path(package.join("index.mjs")).unwrap().to_string(), {"receipt":external_receipt,"instruction":external_instruction,"mcpReceipt":mcp_cwd_receipt}]));
    original["mcp"]["closed-cwd-probe"] =
        json!({"type":"local","command":["node","server.cjs"],"cwd":"~/mcp-cwd"});
    original["instructions"] = json!([external_instruction]);
    original["skills"] = json!({"paths":[selected_skills,"../../scenarios/external-native-resources/selected-skills"]});
    // Native ConfigParse/jsonc-parser keeps only the final resource member.
    // Obsolete targets do not exist; the existing actual plugin/instruction/
    // skill consumers below must still consume each final selected closure.
    let ordinary = serde_json::to_string(&original).unwrap().replace(
        "\"skills\":{",
        "\"skills\":{\"paths\":[\"/missing-obsolete-nested-skills\"],",
    );
    let ordinary = ordinary.replace(
        "\"instructions\":",
        "\"\\u0069\\u006e\\u0073\\u0074\\u0072\\u0075\\u0063\\u0074\\u0069\\u006f\\u006e\\u0073\":",
    );
    let duplicate_resources = format!(
        "{{\"plugin\":[\"file:///missing-obsolete-plugin.mjs\"],\"instructions\":[\"/missing-obsolete-instructions.md\"],\"skills\":{{\"paths\":[\"/missing-obsolete-skills\"]}},{}",
        &ordinary[1..],
    );
    std::fs::write(&original_config, duplicate_resources.as_bytes()).unwrap();
    let original_bytes = std::fs::read(&original_config).unwrap();
    let expected_external = json!({"adjacent":format!("{:x}",Sha256::digest(b"native-adjacent-import")),"child":format!("{:x}",Sha256::digest(b"native-child-dependency")),"parent":format!("{:x}",Sha256::digest(b"native-parent-dependency")),"resource":format!("{:x}",Sha256::digest(b"native-adjacent-resource")),"instruction":format!("{:x}",Sha256::digest(b"native-external-instruction")),"selected":true,"nativeLiveViews":true,"nativeSkill":true,"skillContent":format!("{:x}",Sha256::digest(b"Execute the adjacent synthetic resources.\n")),"skillExecution":format!("{:x}",Sha256::digest(b"native-skill-resource:native-skill-dependency")),"nativeMcpCwd":format!("{:x}",Sha256::digest(b"native-mcp-resource:native-mcp-dependency"))});
    // Five logical native aliases share one accepted immutable 16 MiB raw
    // source. The actual controller stage and actual host must not turn the
    // 80 MiB cumulative read volume into a simultaneous-source limit.
    let repeated_static_source = fixture.join("source-home/.config/opencode/static-capacity.jsonc");
    let mut static_capacity =
        r#"{"agent":{"liveCapacity":{"description":"native-live-capacity-nonce"}}}"#.to_string();
    // JSONC block padding keeps the same inclusive physical-source size while
    // avoiding repeated large strict-JSON renderings in native discovery.
    static_capacity.push_str("/*");
    static_capacity.push_str(&"x".repeat(16 * 1024 * 1024 - static_capacity.len() - 2));
    static_capacity.push_str("*/");
    assert_eq!(static_capacity.len(), 16 * 1024 * 1024);
    assert_eq!(
        freshell_platform::opencode_config::parse_jsonc_object(&static_capacity).unwrap()["agent"]
            ["liveCapacity"]["description"],
        "native-live-capacity-nonce"
    );
    std::fs::write(&repeated_static_source, &static_capacity).unwrap();
    let capacity_aliases = [
        fixture.join("source-home/.config/opencode/config.json"),
        fixture.join("source-home/.config/opencode/opencode.jsonc"),
        fixture.join("workspace/opencode.jsonc"),
        nested.join("opencode.jsonc"),
    ];
    let explicit_config = fixture.join("workspace/selected-config.json");
    let explicit_bytes = br#"{"agent":{"probe":{"description":"{file:./selected-rule}"}}}"#;
    std::fs::write(&explicit_config, explicit_bytes).unwrap();
    let explicit_rule = fixture.join("workspace/selected-rule");
    std::fs::write(&explicit_rule, "native-explicit-selected-rule").unwrap();
    std::fs::set_permissions(&explicit_rule, std::fs::Permissions::from_mode(0o600)).unwrap();
    let tui_plugin = fixture.join("source-home/.config/opencode/plugins/probe-tui");
    std::fs::create_dir_all(&tui_plugin).unwrap();
    std::fs::write(tui_plugin.join("index.mjs"), r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {id:'closed-native-tui-fixture',async tui(api,options){
 const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
 fs.writeFileSync(options.receipt,JSON.stringify({theme:digest(api.tuiConfig.theme),sounds:['default','question','error'].map(name=>digest(fs.readFileSync(api.tuiConfig.attention.sounds[name])))}));
}};
"#).unwrap();
    let selected_tui = fixture.join("workspace/selected-tui.jsonc");
    std::os::unix::fs::symlink("shared.json", &selected_tui).unwrap();
    let project_tui = fixture.join("workspace/tui.jsonc");
    let tui_receipt = fixture.join("workspace/native-tui-consumed.json");
    let selected_sound = external.join("selected.wav");
    let tilde_sound = fixture.join("workspace/~/selected.wav");
    std::fs::create_dir_all(tilde_sound.parent().unwrap()).unwrap();
    std::fs::write(&tilde_sound, b"RIFF-native-literal-tilde-wave").unwrap();
    std::fs::write(
        fixture.join("source-home/selected.wav"),
        b"wrong-home-sound-decoy",
    )
    .unwrap();
    std::fs::write(&selected_sound, b"RIFF-native-selected-wave").unwrap();
    let selected_tui_bytes = format!("{{ // selected origin\n\"tui\":{{\"attention\":{{\"sounds\":{{\"default\":{},\"question\":{},\"error\":\"~/selected.wav\"}}}}}},\"theme\":\"{{file:./selected-theme}}\",\"plugin\":[[\"file:///home/freshell/provider/.config/opencode/plugins/probe-tui/index.mjs\",{{\"receipt\":{}}}]],}}", serde_json::to_string(&selected_sound).unwrap(),serde_json::to_string(&reqwest::Url::from_file_path(&selected_sound).unwrap().to_string()).unwrap(),serde_json::to_string(&tui_receipt).unwrap());
    std::fs::write(&project_tui, &selected_tui_bytes).unwrap();
    std::fs::write(fixture.join("source-home/.config/opencode/tui.json"),
        serde_json::to_vec(&json!({"tui":{"attention":{"sounds":{"subagent_done":"/missing-replaced-sound"}}},"attention":{"sounds":{"default":selected_sound}}})).unwrap()).unwrap();

    std::fs::write(fixture.join("workspace/selected-theme"), "  dark\n").unwrap();
    let inline_source = r#"{ // inline instance origin
"agent":{"probe":{"description":"{env:INLINE_VALUE}"}}}"#;
    let inline_value = "INLINE_PREFIX{file:./inline-rule}INLINE_SUFFIX";
    std::fs::write(nested.join("inline-rule"), "native-inline-selected-rule\n").unwrap();
    let resource_root = fixture.join("workspace/.opencode");
    let root_receipt = fixture.join("workspace/native-root-consumed.json");
    let home_root_receipt = fixture.join("workspace/native-home-root-consumed.json");
    std::fs::create_dir_all(resource_root.join("plugins/selected/node_modules/fixture-dependency"))
        .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/node_modules/fixture-dependency/package.json"),
        r#"{"name":"fixture-dependency","type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/node_modules/fixture-dependency/index.mjs"),
        "export default 'selected-root-dependency';",
    )
    .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/resource"),
        "selected-root-resource",
    )
    .unwrap();
    let selected_root_plugin = r#"import fs from 'node:fs';import crypto from 'node:crypto';import dependency from 'fixture-dependency';
const home=import.meta.url.startsWith('file:///home/freshell/provider/.opencode/');
export default {id:'closed-writable-selected-root-'+(home?'home':'workspace'),async server(input,options){return {async config(config){
 const root=new URL('../../',import.meta.url); const path=new URL('provider-owned-write',root);
 fs.writeFileSync(path,'selected-root-write');
 fs.writeFileSync(home?options.homeReceipt:options.receipt,JSON.stringify({finalExecProfile:nativeExecProfile('self'),physicalHome:process.env.HOME,privateRule:crypto.createHash('sha256').update(config.agent.rootScope.prompt).digest('hex'),dependency:crypto.createHash('sha256').update(dependency).digest('hex'),resource:crypto.createHash('sha256').update(fs.readFileSync(new URL('./resource',import.meta.url))).digest('hex'),write:crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}));
}}}};
"#;
    std::fs::write(
        resource_root.join("plugins/selected/index.mjs"),
        format!("{NATIVE_EXEC_PROFILE}{selected_root_plugin}"),
    )
    .unwrap();
    let root_config = serde_json::to_vec(
        &json!({"agent":{"rootScope":{"prompt":"{file:./private-root-rule}"}}, "plugin":[["./plugins/selected/index.mjs", {"receipt":root_receipt, "homeReceipt":home_root_receipt}]]}),
    )
    .unwrap();
    std::fs::write(resource_root.join("opencode.json"), &root_config).unwrap();
    std::fs::write(
        resource_root.join("private-root-rule"),
        "shared-home-private-rule\n",
    )
    .unwrap();
    std::fs::set_permissions(
        resource_root.join("private-root-rule"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    for name in ["package.json", "package-lock.json"] {
        std::fs::copy(
            fixture.join("source-home/.config/opencode").join(name),
            resource_root.join(name),
        )
        .unwrap();
    }
    std::os::unix::fs::symlink(
        fixture.join("source-home/.config/opencode/node_modules"),
        resource_root.join("node_modules"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&resource_root, fixture.join("source-home/.opencode")).unwrap();
    let explicit_directory = fixture.join("workspace/selected-directory");
    let directory_receipt = fixture.join("workspace/native-directory-consumed.json");
    std::fs::create_dir_all(explicit_directory.join("plugins")).unwrap();
    std::fs::create_dir_all(explicit_directory.join("skills/probe")).unwrap();
    let transported_dependency =
        fixture.join("source-home/.config/opencode/node_modules/transport-only");
    std::fs::create_dir_all(&transported_dependency).unwrap();
    std::fs::write(
        transported_dependency.join("package.json"),
        r#"{"name":"transport-only","type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        transported_dependency.join("index.mjs"),
        "export default 'transport-only-cross-root-dependency';",
    )
    .unwrap();
    std::fs::copy(
        fixture.join("source-home/.config/opencode/package.json"),
        explicit_directory.join("package.json"),
    )
    .unwrap();
    std::fs::copy(
        fixture.join("source-home/.config/opencode/package-lock.json"),
        explicit_directory.join("package-lock.json"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        fixture.join("source-home/.config/opencode/node_modules"),
        explicit_directory.join("node_modules"),
    )
    .unwrap();
    std::fs::write(
        explicit_directory.join("skills/probe/SKILL.md"),
        "selected-directory-skill",
    )
    .unwrap();
    let directory_plugin = format!(
        r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-directory-discovery',async server(){{
 let dependency;
 try {{dependency=(await import('transport-only')).default;}} catch(error) {{
  const link=new URL('../node_modules',import.meta.url);
  fs.writeFileSync({},JSON.stringify({{failureClass:'dependency_load',linkIsSymbolic:fs.lstatSync(link).isSymbolicLink(),linkAbsolute:fs.lstatSync(link).isSymbolicLink()&&fs.readlinkSync(link).startsWith('/'),modulePresent:fs.existsSync(new URL('../node_modules/transport-only/index.mjs',import.meta.url))}}));
  throw error;
 }}
 return {{async config(){{
 const root=new URL('../',import.meta.url);const write=new URL('provider-owned-auto-write',root);
 fs.writeFileSync(write,'selected-directory-write');
 fs.writeFileSync({},JSON.stringify({{linkIsSymbolic:fs.lstatSync(new URL('node_modules',root)).isSymbolicLink(),linkAbsolute:fs.lstatSync(new URL('node_modules',root)).isSymbolicLink()&&fs.readlinkSync(new URL('node_modules',root)).startsWith('/'),dependency:crypto.createHash('sha256').update(dependency).digest('hex'),skill:crypto.createHash('sha256').update(fs.readFileSync(new URL('skills/probe/SKILL.md',root))).digest('hex'),write:crypto.createHash('sha256').update(fs.readFileSync(write)).digest('hex')}}));
}}}}}}}};
"#,
        serde_json::to_string(&directory_receipt).unwrap(),
        serde_json::to_string(&directory_receipt).unwrap()
    );
    std::fs::write(
        explicit_directory.join("plugins/auto-probe.js"),
        directory_plugin,
    )
    .unwrap();

    // Qualify original HOME equal to the Git workspace, with a nested launch
    // cwd. Native project discovery must stay in the workspace while provider
    // HOME remains its independent physical volume.
    let terminal_home = fixture.join("workspace");
    std::env::set_var("XDG_CONFIG_HOME", fixture.join("source-home/.config"));
    std::env::set_var("HOME", &terminal_home);
    let request: ManagedTerminalLaunch = ManagedTerminalLaunch {
        spec: freshell_platform::spawn::SpawnSpec {
            program: "opencode".into(),
            args: vec![],
            env_overrides: BTreeMap::new(),
            cwd: Some(cwd.clone()),
            cols: 120,
            rows: 30,
        },
        env: BTreeMap::from([
            (
                "FRESHELL_TERMINAL_ID".into(),
                "closed-native-terminal".into(),
            ),
            ("OPENCODE_CONFIG_DIR".into(), "../selected-directory".into()),
            ("OPENCODE_CONFIG".into(), "../selected-config.json".into()),
            ("OPENCODE_TUI_CONFIG".into(), "../selected-tui.jsonc".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), inline_source.into()),
            ("INLINE_VALUE".into(), inline_value.into()),
        ]),
        terminal_id: "closed-native-terminal".into(),
        stream_id: "closed-native-stream".into(),
        mode: "opencode".into(),
        resume_session_id: None,
        provider_model: None,
        provider_reasoning_effort: None,
        provider_sandbox: None,
        provider_permission_mode: None,
        view_tab_id: None,
        view_pane_id: None,
        create_request_id: Some("closed-native-terminal-create".into()),
    };
    // Fail through the actual terminal controller before any Docker handoff.
    // Restore every owned fixture before checking the result, including RED.
    for (field, selected) in [
        ("OpenCode plugin", package.join("index.mjs")),
        ("OpenCode instructions", external_instruction.clone()),
        ("OpenCode skills.paths", selected_skills.clone()),
    ] {
        for unreadable in [false, true] {
            let hidden = selected.with_extension("closed-unavailable");
            if unreadable {
                std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0)).unwrap();
            } else {
                std::fs::rename(&selected, &hidden).unwrap();
            }
            let failed = controller.launch(request.clone()).await;
            if unreadable {
                std::fs::set_permissions(
                    &selected,
                    std::fs::Permissions::from_mode(if selected.is_dir() { 0o755 } else { 0o644 }),
                )
                .unwrap();
            } else {
                std::fs::rename(&hidden, &selected).unwrap();
            }
            let error = failed
                .err()
                .expect("selected unavailable resource must block the actual launch");
            assert!(
                error.contains(field)
                    && error.contains(if unreadable { "unreadable" } else { "missing" })
            );
            assert_eq!(
                std::fs::read_dir(fixture.join("handoff")).unwrap().count(),
                0
            );
            assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
            println!(
                "provider_resource_selection_failure {}",
                json!({"field":field,"cause":if unreadable {"unreadable"} else {"missing"},"beforeDockerHandoff":true,"originalsRestored":true})
            );
        }
    }
    // Activate capacity aliases only after the unrelated unavailable-resource
    // controls; each refusal still tests its selected field without rescanning
    // the large static source. Actual launch preparation consumes all aliases.
    for alias in capacity_aliases
        .into_iter()
        .chain([explicit_directory.join("opencode.jsonc")])
    {
        std::os::unix::fs::symlink(&repeated_static_source, alias).unwrap();
    }
    let terminal = controller
        .launch(request)
        .await
        .expect("actual terminal controller/supervisor/host launch");
    let receipt = fixture.join("workspace/native-consumed.json");
    async fn read_receipt(path: &Path) -> Result<Value, &'static str> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        return value;
                    }
                }
                let failure = path.with_file_name(format!(
                    "{}.failure",
                    path.file_name().unwrap().to_string_lossy()
                ));
                if let Ok(bytes) = std::fs::read(&failure) {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        println!("provider_skill_consumer_failure {}", value);
                        panic!("native skill consumer failed; see classified fixture receipt");
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "actual pinned provider startup did not consume selected config and closure")
    }
    let expected = json!({"prompt":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),
        "description":format!("{:x}",Sha256::digest(b"INLINE_PREFIXnative-inline-selected-ruleINLINE_SUFFIX")),
        "references":(["third","fourth","fifth","sixth"].map(|ordinal|format!("{:x}",Sha256::digest(format!("native-{ordinal}-rule").as_bytes())))),
        "resource":format!("{:x}",Sha256::digest(b"plugin-relative-resource")),
        "dependency":format!("{:x}",Sha256::digest(b"plugin-actual-local-dependency")),"sdk":format!("{:x}",Sha256::digest(b"function")),"snapshotDisabled":false});
    let client = controller.runtime_client();
    let terminal_receipt = match read_receipt(&receipt).await {
        Ok(value) => value,
        Err(error) => {
            let output = client
                .read_output(
                    SoulId::parse(terminal.soul_id.clone()).unwrap(),
                    0,
                    64 * 1024,
                )
                .await
                .unwrap();
            let text = output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>();
            let classes = [
                "ConfigInvalidError",
                "ConfigJsonError",
                "JSON parsing",
                "SyntaxError",
                "EACCES",
                "ENOENT",
                "Failed to import",
                "plugin",
                "opencode.json",
                "bun install",
                "install",
                "Resolving",
                "package",
                "lockfile",
                "Permission denied",
                "ModuleNotFound",
            ]
            .into_iter()
            .filter(|class| text.contains(class))
            .collect::<Vec<_>>();
            println!(
                "provider_launch_diagnostic {}",
                json!({"route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes,"containsAuthSentinel":text.contains("AUTH_PREFIX"),"containsGeneratedName":text.contains("FRESHELL_CONFIG_REFERENCE_0")})
            );
            panic!("{error}");
        }
    };
    assert_eq!(terminal_receipt, expected);
    assert_eq!(
        read_receipt(&external_receipt).await.unwrap(),
        expected_external
    );
    assert_eq!(
        std::fs::read_to_string(package.join("index.mjs")).unwrap(),
        external_plugin
    );
    assert_eq!(
        std::fs::read(&external_instruction).unwrap(),
        b"native-external-instruction"
    );
    let expected_root = json!({"finalExecProfile":native_exec_profile(),"physicalHome":"/home/freshell/provider","privateRule":format!("{:x}",Sha256::digest(b"shared-home-private-rule")),"dependency":format!("{:x}",Sha256::digest(b"selected-root-dependency")),"resource":format!("{:x}",Sha256::digest(b"selected-root-resource")),"write":format!("{:x}",Sha256::digest(b"selected-root-write"))});
    assert_eq!(read_receipt(&root_receipt).await.unwrap(), expected_root);
    assert_eq!(
        read_receipt(&home_root_receipt).await.unwrap(),
        expected_root,
        "actual native HOME and workspace discovery must both consume the shared transported root"
    );
    let expected_directory = json!({"linkIsSymbolic":true,"linkAbsolute":true,"dependency":format!("{:x}",Sha256::digest(b"transport-only-cross-root-dependency")),"skill":format!("{:x}",Sha256::digest(b"selected-directory-skill")),"write":format!("{:x}",Sha256::digest(b"selected-directory-write"))});
    assert_eq!(
        read_receipt(&directory_receipt).await.unwrap(),
        expected_directory
    );
    assert!(!explicit_directory
        .join("provider-owned-auto-write")
        .exists());
    assert!(
        !resource_root.join("provider-owned-write").exists(),
        "native writes must land in the selected soul subpath, preserving originals"
    );
    assert_eq!(
        std::fs::read(resource_root.join("opencode.json")).unwrap(),
        root_config
    );
    let shared_consumption = read_receipt(&shared_receipt).await;
    if shared_consumption.is_err() {
        let output = client
            .read_output(
                SoulId::parse(terminal.soul_id.clone()).unwrap(),
                0,
                1024 * 1024,
            )
            .await
            .unwrap();
        let text = output
            .frames
            .iter()
            .map(|frame| frame.data.as_str())
            .collect::<String>();
        let classes = [
            "shared-probe",
            "SyntaxError",
            "TypeError",
            "ConfigInvalidError",
            "ConfigJsonError",
            "ENOENT",
            "EACCES",
            "failed to load plugin",
            "Plugin export",
            "OpenSSL",
            "certificate",
            "Failed to import",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"route":"shared-main","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
        );
    }
    assert_eq!(
        shared_consumption.unwrap(),
        json!({"root":{"relative":format!("{:x}",Sha256::digest(b"native-shared-root-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))},"nested":{"relative":format!("{:x}",Sha256::digest(b"native-shared-nested-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))}})
    );
    assert_eq!(
        read_receipt(&tui_receipt)
            .await
            .expect("actual TUI plugin must consume the selected effective TUI configuration"),
        json!({"theme":format!("{:x}",Sha256::digest(b"dark")),"sounds":[format!("{:x}",Sha256::digest(b"RIFF-native-selected-wave")),format!("{:x}",Sha256::digest(b"RIFF-native-selected-wave")),format!("{:x}",Sha256::digest(b"RIFF-native-literal-tilde-wave"))]})
    );
    let ca_digest = format!(
        "{:x}",
        Sha256::digest(
            std::fs::read_to_string(fixture.join("grants/ca.pem"))
                .unwrap()
                .trim()
                .as_bytes()
        )
    );
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.main"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),"ca":ca_digest})
    );
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.tui"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"synthetic-onecli-shadowed")),"ca":ca_digest,"theme":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(read_receipt(&shared_lane_receipt.with_extension("root.rebind")).await.unwrap(), json!({"alive":true}),
        "the actual native TUI loader must execute the owned package entrypoint, not merely retain its config spec");
    assert_eq!(
        std::fs::read_to_string(&project_tui).unwrap(),
        selected_tui_bytes
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal-tui","digest":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&shared_source).unwrap(), shared_bytes);
    assert_eq!(
        std::fs::read_to_string(&repeated_static_source).unwrap(),
        static_capacity
    );
    assert!(
        std::fs::symlink_metadata(fixture.join("workspace/opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(std::fs::symlink_metadata(nested.join("opencode.json"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&explicit_config).unwrap(), explicit_bytes);
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal","finalExecProfile":native_exec_profile(),"workspaceScope":"default-home","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&expected).unwrap()))})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(&shared_receipt).unwrap();
    std::fs::remove_file(&root_receipt).unwrap();
    std::fs::remove_file(&external_receipt).unwrap();
    std::fs::remove_file(&home_root_receipt).unwrap();
    std::fs::remove_file(&directory_receipt).unwrap();
    std::fs::remove_file(shared_lane_receipt.with_extension("root.main")).unwrap();
    // Fresh launches use current server controls; the terminal exercised a
    // request-only relative control. Both must activate the explicit layer.
    // The fresh route has a workspace beneath original HOME. Both role
    // topologies consume the same independently retained synthetic fixtures.
    std::os::unix::fs::symlink(&resource_root, fixture.join(".opencode")).unwrap();
    std::os::unix::fs::symlink(&shared_home_rule, fixture.join("home rule with spaces.txt"))
        .unwrap();
    std::fs::write(fixture.join("grants/auth.json"), serde_json::to_vec(&json!({well_known_url: {
        "type":"wellknown", "key":"OPENAI_API_KEY", "token":"AUTH_PREFIX{file:~/home rule with spaces.txt}AUTH_SUFFIX"
    }, inline_auth_url: {"type":"wellknown", "key":"INLINE_VALUE", "token":"AUTH_INLINE_SHADOW_NO_FILE"}})).unwrap()).unwrap();
    std::env::set_var("HOME", &fixture);
    std::env::set_var("OPENCODE_CONFIG", &explicit_config);
    std::env::set_var("OPENCODE_CONFIG_DIR", &explicit_directory);
    std::env::set_var("OPENCODE_TUI_CONFIG", &selected_tui);
    std::env::set_var("OPENCODE_CONFIG_CONTENT", inline_source);
    std::env::set_var("INLINE_VALUE", inline_value);
    let mut fresh_expected = expected.clone();
    fresh_expected["snapshotDisabled"] = json!(true);
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    let message:freshell_protocol::FreshAgentCreate=serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":"freshopencode","provider":"opencode","cwd":cwd,"model":"closed-fixture/unavailable"})).unwrap();
    Arc::clone(&proxy)
        .dispatch(HostedFreshAgentCommand::Create(message))
        .await;
    let created = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let raw = events.recv().await.unwrap();
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                panic!("actual fresh launch failed: {}", frame["message"]);
            }
            if frame["type"] == "freshAgent.created" {
                break frame;
            }
        }
    })
    .await
    .expect("actual fresh create response");
    assert!(created["sessionId"].as_str().is_some());
    // OpenCode preserves a zero-turn placeholder until its first send. The
    // synthetic native plugin rejects chat.message before the model/title loop;
    // exercise the real gateway's first-start path without a model request.
    let send = serde_json::from_value(json!({
        "requestId":"closed-native-fresh-startup", "provider":"opencode",
        "sessionType":"freshopencode", "sessionId":created["sessionId"],
        "text":"closed synthetic startup qualification", "cwd":cwd
    }))
    .unwrap();
    Arc::clone(&proxy)
        .dispatch(HostedFreshAgentCommand::Send(send))
        .await;
    assert_eq!(read_receipt(&receipt).await.unwrap(), fresh_expected);
    assert_eq!(
        read_receipt(&external_receipt).await.unwrap(),
        expected_external
    );
    assert_eq!(
        std::fs::read_to_string(package.join("index.mjs")).unwrap(),
        external_plugin
    );
    assert_eq!(
        std::fs::read(&external_instruction).unwrap(),
        b"native-external-instruction"
    );
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.main"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),"ca":ca_digest})
    );
    assert_eq!(read_receipt(&root_receipt).await.unwrap(), expected_root);
    assert_eq!(
        read_receipt(&home_root_receipt).await.unwrap(),
        expected_root
    );
    assert_eq!(
        read_receipt(&directory_receipt).await.unwrap(),
        expected_directory
    );
    assert!(!explicit_directory
        .join("provider-owned-auto-write")
        .exists());
    assert!(!resource_root.join("provider-owned-write").exists());
    assert_eq!(
        std::fs::read(resource_root.join("opencode.json")).unwrap(),
        root_config
    );
    assert_eq!(
        read_receipt(&shared_receipt).await.unwrap(),
        json!({"root":{"relative":format!("{:x}",Sha256::digest(b"native-shared-root-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))},"nested":{"relative":format!("{:x}",Sha256::digest(b"native-shared-nested-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))}})
    );
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&shared_source).unwrap(), shared_bytes);
    assert_eq!(
        std::fs::read_to_string(&repeated_static_source).unwrap(),
        static_capacity
    );
    assert!(
        std::fs::symlink_metadata(fixture.join("workspace/opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(std::fs::symlink_metadata(nested.join("opencode.json"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&explicit_config).unwrap(), explicit_bytes);
    let stopped = fixture.join("workspace/native-consumed.json.stopped");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read(&stopped)
                .is_ok_and(|value| value == b"FRESHELL_SYNTHETIC_STARTUP_STOP")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("native plugin must stop the fresh request before the model loop");
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"fresh","finalExecProfile":native_exec_profile(),"workspaceScope":"workspace-under-home","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&fresh_expected).unwrap()))})
    );
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    web_task.abort();
    let _ = web_task.await;
    control_task.abort();
    let _ = control_task.await;
    // Each prepared root is also scanned before publication. Join owned
    // writers before this final complete scan so retiring SQLite/temp entries
    // cannot disappear between enumeration and reading. No entry is omitted.
    assert_private_sentinels_absent(&fixture.join("registry"), &certificate_sentinel);
    assert_private_sentinels_absent(&fixture.join("handoff"), &certificate_sentinel);
}
