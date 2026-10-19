use crate::{
    command_journal::{BeginDisposition, CommandJournal},
    output_journal::OutputJournal,
    providers::PreparedCodexLaunch,
};
use freshell_codex::{launch_lifecycle::CodexLaunchSidecar, remote_proxy::RemoteProxyEvent};
use freshell_platform::SpawnSpec;
use freshell_protocol::ServerMessage;
use freshell_runtime_protocol::{
    CommandState, IncarnationId, OpenCodeAdoptionBaseline, OpenCodeAdoptionExpectation,
    OpenCodeAdoptionObservation, OpenCodeAdoptionStatus, OpenCodeMessagesRead,
    OpenCodeVerifiedRootTail, RequestId, RuntimeError, RuntimeErrorCode, RuntimeOutputBatch,
    TerminalLaunchSpec,
};
use freshell_sessions::parse::opencode::{OpencodeProvider, OpencodeSessionRow};
use freshell_terminal::PtyTerminal;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, task::JoinHandle};

const OPENCODE_ADOPTION_SIGNAL_ROOT: &str =
    "/home/freshell/provider/.freshell/session-signals/opencode-adoption";

pub(crate) type OpenCodeAdoptionRevalidator = Arc<
    dyn Fn(
            &OpenCodeAdoptionBaseline,
        )
            -> Result<freshell_agent_runtime::opencode_transfer::CurrentOpenCodeEvidence, String>
        + Send
        + Sync,
>;

struct CodexLifecycle {
    sidecar: Arc<CodexLaunchSidecar>,
    event_task: JoinHandle<()>,
}

pub struct HostedPty {
    pty: PtyTerminal,
    output: Arc<Mutex<OutputJournal>>,
    commands: CommandJournal,
    exited: Arc<AtomicBool>,
    exit_code: Arc<AtomicI64>,
    terminal_id: String,
    state_dir: PathBuf,
    stream_epoch: String,
    native_session_id: Arc<Mutex<Option<String>>>,
    native_identity_launch: Option<freshell_runtime_protocol::NativeIdentityLaunch>,
    provider_mode: String,
    native_signal: Option<(PathBuf, u32, u32, String)>,
    amplifier_signal_reader: Mutex<crate::providers::native_identity::AmplifierObservationReader>,
    native_cwd: PathBuf,
    opencode_adoption: Option<Arc<Mutex<OpenCodeAdoptionGate>>>,
    opencode_activity: Option<crate::opencode_activity::OpencodeActivityRelay>,
    codex_activity: Option<Arc<Mutex<crate::codex_activity::CodexActivityJournal>>>,
    codex: Option<CodexLifecycle>,
}

#[cfg(all(test, unix))]
#[path = "managed_opencode_output_tests.rs"]
mod managed_opencode_output_tests;

pub(crate) async fn write_hosted_input(
    terminal: &tokio::sync::Mutex<Option<HostedPty>>,
    request_id: &RequestId,
    data: &str,
) -> Result<CommandState, RuntimeError> {
    let (readiness, epoch, state_dir, terminal_id) = {
        let mut terminal = terminal.lock().await;
        let hosted = terminal.as_mut().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::UnsupportedWorkload,
                "incarnation is not a managed terminal",
            )
        })?;
        let Some(relay) = &hosted.opencode_activity else {
            return hosted.write_input(request_id, data);
        };
        if matches!(
            hosted
                .commands
                .existing_disposition(request_id, data.as_bytes())?,
            Some(BeginDisposition::Completed | BeginDisposition::Ambiguous)
        ) {
            return hosted.write_input(request_id, data);
        }
        (
            relay.input_readiness(),
            hosted.stream_epoch.clone(),
            hosted.state_dir.clone(),
            hosted.terminal_id.clone(),
        )
    };
    // Waiting holds neither the PTY lock nor a command-journal claim. Output,
    // exit and stop remain available; refused input has never been dispatched.
    if let Err(error) = readiness.wait().await {
        crate::opencode_activity::log_diagnostic(
            &state_dir,
            "managed_opencode.activity_input_refused",
            serde_json::json!({
                "terminalId": terminal_id,
                "diagnosticCode": format!("{:?}", error.diagnostic_code)
            }),
        );
        return Err(error);
    }
    let mut terminal = terminal.lock().await;
    let hosted = terminal.as_mut().ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::UnsupportedWorkload,
            "incarnation is not a managed terminal",
        )
    })?;
    if hosted.stream_epoch != epoch {
        return Err(RuntimeError::new(
            RuntimeErrorCode::OwnershipMismatch,
            "input source changed while waiting for native activity",
        ));
    }
    hosted.write_input(request_id, data)
}

impl HostedPty {
    pub async fn spawn(
        state_dir: &Path,
        incarnation_id: IncarnationId,
        launch: &TerminalLaunchSpec,
        child_secret_env: BTreeMap<String, String>,
        prepared_codex: Option<PreparedCodexLaunch>,
        claude_settings: Option<String>,
        opencode_adoption_revalidator: Option<OpenCodeAdoptionRevalidator>,
    ) -> Result<Self, String> {
        launch.validate().map_err(|e| e.message)?;
        let native_identity_launch =
            crate::providers::native_identity::launch_from_environment(&child_secret_env)?;
        if native_identity_launch
            .as_ref()
            .is_some_and(|binding| binding.incarnation_id != incarnation_id)
        {
            return Err("native launch belongs to another incarnation".into());
        }
        let opencode_adoption = launch
            .opencode_adoption
            .as_ref()
            .map(|expectation| {
                OpenCodeAdoptionGate::new(
                    launch.terminal_id.clone(),
                    incarnation_id.clone(),
                    expectation.clone(),
                    opencode_adoption_revalidator
                        .clone()
                        .ok_or("OpenCode adoption verifier is unavailable for a gated launch")?,
                    PathBuf::from(OPENCODE_ADOPTION_SIGNAL_ROOT),
                    launch.run_as_uid,
                    launch.run_as_gid,
                )
                .map(|gate| Arc::new(Mutex::new(gate)))
            })
            .transpose()?;
        let launch_floor_ms = epoch_ms().saturating_sub(500);
        let stream_epoch = format!(
            "{}-{}",
            launch.stream_id,
            freshell_runtime_protocol::HostBootId::new()
        );
        let output = Arc::new(Mutex::new(OutputJournal::new(
            state_dir,
            incarnation_id,
            launch.terminal_id.clone(),
            stream_epoch.clone(),
        )?));
        let sink_output = Arc::clone(&output);
        let sink = Box::new(move |message: ServerMessage| {
            if let ServerMessage::TerminalOutput(frame) = message {
                if let Ok(mut journal) = sink_output.lock() {
                    if journal.append(&frame.data).is_err() {
                        journal.record_failure();
                        tracing::error!(
                            event = "managed_runtime.output_writer_failed",
                            cause = "spool_write",
                            "Retained output writer failed"
                        );
                    }
                }
            }
        });
        let exited = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(AtomicI64::new(0));
        let exit_flag = Arc::clone(&exited);
        let exit_value = Arc::clone(&exit_code);
        let native_exit_notify = Arc::new(tokio::sync::Notify::new());
        let notify_on_exit = native_exit_notify.clone();
        let codex_sidecar_on_exit = prepared_codex
            .as_ref()
            .map(|prepared| Arc::clone(&prepared.sidecar));
        let runtime_handle = tokio::runtime::Handle::try_current().ok();
        let settled_output = Arc::clone(&output);
        let on_exit = Box::new(move |code: i64| {
            // The PTY reader calls this only after its final framer flush.
            let settled = settled_output
                .lock()
                .map(|mut journal| journal.complete(code).is_ok())
                .unwrap_or(false);
            // Process exit is independent of whether retained output settled;
            // supervision must never reattach a process that has already exited.
            exit_value.store(code, Ordering::SeqCst);
            exit_flag.store(true, Ordering::SeqCst);
            if !settled {
                tracing::error!(
                    event = "managed_runtime.output_completion_failed",
                    cause = "spool_settlement",
                    "Output completion could not be committed"
                );
            }
            notify_on_exit.notify_one();
            if let (Some(handle), Some(sidecar)) =
                (runtime_handle.as_ref(), codex_sidecar_on_exit.as_ref())
            {
                let sidecar = Arc::clone(sidecar);
                handle.spawn(async move {
                    let _ = sidecar.shutdown().await;
                });
            }
        });
        let mut provider_args = crate::provider_identity_args(launch.run_as_uid, launch.run_as_gid);
        provider_args.push(launch.program.clone());
        let mut native_args = launch.args.clone();
        if launch.mode == "claude" {
            for index in 1..native_args.len() {
                if native_args[index - 1] == "--settings"
                    && native_args[index]
                        == freshell_platform::claude_inputs::MANAGED_SETTINGS_ARGUMENT
                {
                    native_args[index] = claude_settings.as_ref().ok_or("selected Claude settings origin is unavailable; retain inputs and reprepare before dispatch")?.clone();
                }
            }
        }
        // Managed images own the native pin. An updater's input prompt must
        // never precede the provider's no-input create/resume acknowledgement.
        if launch.mode == "codex"
            && native_identity_launch.is_some()
            && !native_args
                .windows(2)
                .any(|pair| pair[0] == "-c" && pair[1] == "check_for_update_on_startup=false")
        {
            native_args.splice(
                0..0,
                ["-c".into(), "check_for_update_on_startup=false".into()],
            );
        }
        let mut statusline_settings = None;
        if launch.mode == "claude" && native_identity_launch.is_some() {
            for index in 0..native_args.len().saturating_sub(1) {
                if native_args[index] == "--settings" {
                    let mut settings = freshell_platform::claude_inputs::settings_with_owned_hooks(
                        native_args[index + 1].as_bytes(),
                    )
                    .map_err(str::to_string)?;
                    let owned: serde_json::Value = serde_json::from_str(
                        &freshell_platform::cli_launch::claude_managed_settings_json(),
                    )
                    .map_err(|_| "owned Claude settings are invalid")?;
                    if let Some(selected) = settings
                        .get("statusLine")
                        .filter(|selected| *selected != &owned["statusLine"])
                    {
                        statusline_settings = Some(selected.to_string());
                    }
                    for (event, groups) in owned["hooks"]
                        .as_object()
                        .ok_or("owned Claude hooks are invalid")?
                    {
                        let selected = settings["hooks"]
                            .as_object_mut()
                            .ok_or("selected Claude hooks are invalid")?
                            .entry(event)
                            .or_insert_with(|| serde_json::json!([]))
                            .as_array_mut()
                            .ok_or("selected Claude hook groups are invalid")?;
                        for group in groups
                            .as_array()
                            .ok_or("owned Claude hook groups are invalid")?
                        {
                            if !selected.contains(group) {
                                selected.push(group.clone());
                            }
                        }
                    }
                    settings["statusLine"] = owned["statusLine"].clone();
                    native_args[index + 1] = settings.to_string();
                }
            }
        }
        provider_args.extend(native_args);
        let spec = SpawnSpec {
            program: "/usr/bin/setpriv".to_string(),
            args: provider_args,
            env_overrides: BTreeMap::new(),
            cwd: Some(launch.cwd.clone()),
            cols: launch.cols,
            rows: launch.rows,
        };
        let mut provider_env = launch.env.clone();
        provider_env.extend(child_secret_env);
        if launch.mode == "opencode" && native_identity_launch.is_some() {
            // The managed image owns the native version; an automatic install
            // cannot precede its no-input loader acknowledgement.
            provider_env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "true".into());
        }
        if let Some(settings) = statusline_settings {
            provider_env.insert("FRESHELL_NATIVE_STATUSLINE_SETTINGS".into(), settings);
        }
        // The PTY replaces inherited environment. setpriv must retain the
        // runtime image's command search path, including installed CLIs in
        // /usr/local/bin, while preserving an explicit launch PATH.
        if let Ok(image_path) = std::env::var("PATH") {
            provider_env.entry("PATH".into()).or_insert(image_path);
        }
        if matches!(
            launch.mode.as_str(),
            "claude" | "codex" | "opencode" | "amplifier"
        ) {
            provider_env
                .entry("HOME".into())
                .or_insert_with(|| freshell_agent_runtime::PROVIDER_HOME.into());
        }
        let native_signal = if matches!(launch.mode.as_str(), "claude" | "amplifier")
            || (launch.mode == "opencode" && opencode_adoption.is_none())
        {
            native_identity_launch
                .as_ref()
                .map(|binding| {
                    let home = provider_env
                        .get("HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("/home/freshell/provider"));
                    let directory =
                        crate::providers::native_identity::signal_directory(&home, binding)?;
                    provider_env.insert(
                        crate::providers::native_identity::SIGNAL_DIR_ENV.into(),
                        directory.to_string_lossy().into(),
                    );
                    let name = match launch.mode.as_str() {
                        "amplifier" => "amplifier-loaded-context.json",
                        "opencode" => "opencode-loaded.json",
                        _ => "session-start.json",
                    };
                    Ok::<_, String>((
                        directory.join(name),
                        launch.run_as_uid,
                        launch.run_as_gid,
                        native_startup_source(
                            &launch.mode,
                            &launch.args,
                            launch.resume_session_id.is_some(),
                        )
                        .into(),
                    ))
                })
                .transpose()?
        } else {
            None
        };
        if let Some(expectation) = launch.opencode_adoption.as_ref() {
            set_opencode_adoption_environment(&mut provider_env, expectation);
            provider_env.insert("FRESHELL_TERMINAL_ID".into(), launch.terminal_id.clone());
        }
        // Rootless Docker maps the host user's bind-mounted workspace to
        // container uid 0, while the provider intentionally runs as uid
        // 65534. Tell Git that this one already-approved workspace is safe
        // without modifying host or provider-global git configuration.
        provider_env.insert("GIT_CONFIG_COUNT".into(), "1".into());
        provider_env.insert("GIT_CONFIG_KEY_0".into(), "safe.directory".into());
        provider_env.insert("GIT_CONFIG_VALUE_0".into(), launch.workspace_path.clone());
        let spawn = (|| {
            #[cfg(target_os = "linux")]
            freshell_platform::provider_exec::check_final_exec(
                &spec.program,
                &spec.args,
                &provider_env,
                &[&launch.program],
                freshell_platform::provider_exec::process_profile()
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            PtyTerminal::spawn_with_sink(
                &spec,
                &provider_env,
                &launch.terminal_id,
                &launch.stream_id,
                None,
                Some(sink),
                Some(on_exit),
            )
            .map_err(|error| error.to_string())
        })();
        let mut pty = match spawn {
            Ok(pty) => pty,
            Err(error) => {
                if let Some(prepared) = prepared_codex {
                    let _ = prepared.sidecar.shutdown().await;
                }
                return Err(error.to_string());
            }
        };
        let commands = CommandJournal::open(state_dir)?;
        // Codex must report the thread identity through its app-server proxy;
        // do not treat the requested resume id as provider-observed evidence.
        let native_session_id = Arc::new(Mutex::new(None));
        if launch.mode == "opencode"
            && launch.resume_session_id.is_none()
            && native_identity_launch.is_none()
        {
            spawn_opencode_identity_watcher(
                launch,
                launch_floor_ms,
                Arc::clone(&native_session_id),
                Arc::clone(&exited),
            );
        }
        if launch.mode == "opencode" {
            if let Some(adoption_gate) = opencode_adoption.as_ref() {
                if let Err(error) = spawn_opencode_adoption_signal_relay(
                    &launch.terminal_id,
                    launch.run_as_uid,
                    launch.run_as_gid,
                    adoption_gate.clone(),
                    Arc::clone(&native_session_id),
                    Arc::clone(&exited),
                ) {
                    pty.kill();
                    return Err(error);
                }
            } else if native_identity_launch.is_none() {
                spawn_opencode_signal_relay(
                    &launch.terminal_id,
                    launch.run_as_uid,
                    launch.run_as_gid,
                    Arc::clone(&native_session_id),
                    Arc::clone(&exited),
                );
            }
        }
        let codex_activity = prepared_codex.as_ref().map(|_| {
            Arc::new(Mutex::new(
                crate::codex_activity::CodexActivityJournal::default(),
            ))
        });
        let codex = if let Some(prepared) = prepared_codex {
            if let Err(error) = prepared.sidecar.adopt(&launch.terminal_id, 0).await {
                pty.kill();
                let _ = prepared.sidecar.shutdown().await;
                return Err(format!("adopt managed Codex app-server: {error}"));
            }
            let sidecar = Arc::clone(&prepared.sidecar);
            let event_task = tokio::spawn(run_codex_native_events(
                prepared.events,
                Arc::clone(&sidecar),
                state_dir.to_path_buf(),
                launch.resume_session_id.clone(),
                Arc::clone(&native_session_id),
                Arc::clone(
                    codex_activity
                        .as_ref()
                        .expect("Codex launch has an activity journal"),
                ),
            ));
            Some(CodexLifecycle {
                sidecar,
                event_task,
            })
        } else {
            None
        };
        let opencode_activity = if launch.mode == "opencode" {
            match crate::opencode_activity::endpoint(&launch.args) {
                Some(endpoint) => Some(crate::opencode_activity::OpencodeActivityRelay::spawn(
                    launch.terminal_id.clone(),
                    state_dir.to_path_buf(),
                    endpoint,
                    exited.clone(),
                    native_exit_notify,
                )),
                None => {
                    crate::opencode_activity::log_diagnostic(
                        state_dir,
                        "managed_opencode.activity_lane_unavailable",
                        serde_json::json!({
                            "terminalId": launch.terminal_id,
                            "reason": "missing_loopback_endpoint"
                        }),
                    );
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            pty,
            output,
            commands,
            exited,
            exit_code,
            terminal_id: launch.terminal_id.clone(),
            state_dir: state_dir.to_path_buf(),
            stream_epoch,
            native_session_id,
            native_identity_launch,
            provider_mode: launch.mode.clone(),
            native_signal,
            amplifier_signal_reader: Mutex::default(),
            native_cwd: PathBuf::from(&launch.cwd),
            opencode_adoption,
            opencode_activity,
            codex_activity,
            codex,
        })
    }

    pub fn write_input(
        &mut self,
        request_id: &RequestId,
        data: &str,
    ) -> Result<CommandState, RuntimeError> {
        let adoption_gate = self.opencode_adoption.clone();
        let native_ready = !matches!(
            self.provider_mode.as_str(),
            "claude" | "codex" | "opencode" | "amplifier"
        ) || self.native_identity_observation().is_some();
        let activity_readiness = self
            .opencode_activity
            .as_ref()
            .map(|relay| relay.input_readiness());
        let disposition =
            begin_input_after_gate(&mut self.commands, request_id, data.as_bytes(), || {
                if let Some(activity_readiness) = &activity_readiness {
                    activity_readiness.ensure_ready()?;
                }
                if !native_ready {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::RecoveryBlocked,
                        "provider has not acknowledged the current native session",
                    ));
                }
                let Some(gate) = adoption_gate.as_ref() else {
                    return Ok(true);
                };
                let mut gate = gate.lock().map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "OpenCode adoption gate lock is unavailable",
                    )
                })?;
                Ok(gate.release_input())
            })?;
        match disposition {
            BeginDisposition::Completed => return Ok(CommandState::Completed),
            BeginDisposition::Ambiguous => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::CommandAmbiguous,
                    "input may already have reached the PTY; refusing automatic redispatch",
                ))
            }
            BeginDisposition::Dispatch => {}
        }
        self.commands.mark_dispatching(request_id)?;
        self.pty
            .write_input(data.as_bytes())
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e.to_string()))?;
        self.commands.mark_completed(request_id)?;
        Ok(CommandState::Completed)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), RuntimeError> {
        if cols == 0 || rows == 0 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRequest,
                "terminal dimensions must be positive",
            ));
        }
        self.pty.resize(cols, rows);
        Ok(())
    }

    pub fn read_output(
        &self,
        incarnation_id: IncarnationId,
        after_seq: u64,
        max_bytes: u64,
        expected_stream_epoch: Option<&str>,
    ) -> Result<RuntimeOutputBatch, RuntimeError> {
        let (effective_after, source_changed) =
            output_read_position(&self.stream_epoch, expected_stream_epoch, after_seq);
        let mut batch = self
            .output
            .lock()
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::HostUnreachable,
                    "output journal lock poisoned",
                )
            })?
            .read(effective_after, max_bytes)
            .map_err(|e| RuntimeError::new(RuntimeErrorCode::HostUnreachable, e))?;
        batch.incarnation_id = incarnation_id;
        if source_changed {
            batch.reset_required = true;
            batch.truncated = true;
        }
        batch.exited = self.exited();
        batch.exit_code = self.exited().then(|| self.exit_code());
        batch.native_session_id = if self.native_identity_launch.is_some() {
            // Output is the supervisor's durable identity boundary. Re-read
            // qualified native proof so withdrawn evidence cannot use a cache.
            self.native_identity_observation()
                .map(|observation| observation.native_session_id)
        } else {
            self.native_session_id()
        };
        batch.opencode_activity = self.opencode_activity.as_ref().map(|relay| relay.read());
        batch.codex_activity = self
            .codex_activity
            .as_ref()
            .map(|journal| journal.lock().expect("Codex activity journal lock").read());
        Ok(batch)
    }

    pub async fn stop(&mut self) {
        self.opencode_activity.take();
        self.pty.stop_and_join_output();
        if let Some(codex) = self.codex.take() {
            codex.event_task.abort();
            let _ = codex.sidecar.shutdown().await;
        }
    }
    pub fn pid(&self) -> u32 {
        self.pty.pid().unwrap_or(0)
    }
    pub fn exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }
    pub fn exit_code(&self) -> i64 {
        self.exit_code.load(Ordering::SeqCst)
    }
    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }
    pub fn stream_epoch(&self) -> &str {
        &self.stream_epoch
    }
    pub fn head_seq(&self) -> u64 {
        self.output.lock().map(|j| j.head_seq()).unwrap_or(0)
    }
    pub fn spool_bytes(&self) -> u64 {
        self.output.lock().map(|j| j.spool_bytes()).unwrap_or(0)
    }
    pub fn native_session_id(&self) -> Option<String> {
        self.native_session_id
            .lock()
            .ok()
            .and_then(|session| session.clone())
    }

    pub fn native_identity_observation(
        &self,
    ) -> Option<freshell_runtime_protocol::NativeIdentityObservation> {
        use freshell_runtime_protocol::NativeIdentitySource;
        if self.exited() {
            return None;
        }
        let launch = self.native_identity_launch.as_ref()?;
        if let Some((path, uid, gid, source)) = self.native_signal.as_ref() {
            let result = if self.provider_mode == "opencode" {
                crate::providers::native_identity::read_opencode_observation(
                    path, *uid, *gid, launch,
                )
            } else if self.provider_mode == "amplifier" {
                self.amplifier_signal_reader
                    .lock()
                    .map_err(|_| "native Amplifier reader state unavailable".to_string())
                    .and_then(|mut reader| reader.read(path, *uid, *gid, launch, source))
            } else {
                crate::providers::native_identity::read_claude_observation(
                    path,
                    *uid,
                    *gid,
                    launch,
                    source,
                    &self.native_cwd,
                )
            };
            return match result {
                Ok(observation) if !self.exited() => observation,
                Ok(_) => None,
                Err(reason) => {
                    tracing::warn!(incarnation_id=%launch.incarnation_id,launch_nonce=%launch.launch_nonce,evidence_revision=launch.evidence_revision,execution_generation=launch.execution_generation,provider=%self.provider_mode,reason,"managed_provider.native_identity_blocked");
                    None
                }
            };
        }
        let native = self.native_session_id()?;
        let (source, evidence) = match self.provider_mode.as_str() {
            "codex" => (
                NativeIdentitySource::CodexAppServer,
                serde_json::json!({"threadId":native,"handshake":"app_server"}),
            ),
            "opencode" => match self.opencode_adoption_status() {
                OpenCodeAdoptionStatus::Observed { observation } => (
                    NativeIdentitySource::OpencodeTui,
                    serde_json::to_value(observation).ok()?,
                ),
                _ => return None,
            },
            _ => return None,
        };
        crate::providers::native_identity::bind_provider_observation(
            launch, &native, source, &evidence,
        )
    }

    pub fn opencode_adoption_status(&self) -> OpenCodeAdoptionStatus {
        self.opencode_adoption
            .as_ref()
            .and_then(|gate| gate.lock().ok().map(|gate| gate.status()))
            .unwrap_or(OpenCodeAdoptionStatus::NotRequired)
    }
}

fn begin_input_after_gate(
    commands: &mut CommandJournal,
    request_id: &RequestId,
    data: &[u8],
    release_gate: impl FnOnce() -> Result<bool, RuntimeError>,
) -> Result<BeginDisposition, RuntimeError> {
    match commands.existing_disposition(request_id, data)? {
        Some(BeginDisposition::Completed) => return Ok(BeginDisposition::Completed),
        Some(BeginDisposition::Ambiguous) => return Ok(BeginDisposition::Ambiguous),
        Some(BeginDisposition::Dispatch) | None => {}
    }
    if !release_gate()? {
        return Err(RuntimeError::new(
            RuntimeErrorCode::RecoveryBlocked,
            "OpenCode is waiting for a fresh provider session observation",
        ));
    }
    commands.begin(request_id, data)
}

struct OpenCodeAdoptionGate {
    terminal_id: String,
    incarnation_id: IncarnationId,
    expectation: OpenCodeAdoptionExpectation,
    observation: Option<OpenCodeAdoptionObservation>,
    released: bool,
    verifier: OpenCodeAdoptionRevalidator,
    expectation_path: PathBuf,
    provider_uid: u32,
    provider_gid: u32,
    verification_failed: bool,
}

impl OpenCodeAdoptionGate {
    fn new(
        terminal_id: String,
        incarnation_id: IncarnationId,
        expectation: OpenCodeAdoptionExpectation,
        verifier: OpenCodeAdoptionRevalidator,
        signal_root: PathBuf,
        provider_uid: u32,
        provider_gid: u32,
    ) -> Result<Self, String> {
        expectation.validate().map_err(|error| error.message)?;
        if terminal_id.is_empty()
            || expectation.incarnation_id != incarnation_id
            || provider_uid == 0
        {
            return Err(
                "OpenCode adoption expectation belongs to another terminal incarnation".into(),
            );
        }
        let expectation_path = signal_root.join(format!("{terminal_id}.expected.json"));
        let gate = Self {
            terminal_id,
            incarnation_id,
            expectation,
            observation: None,
            released: false,
            verifier,
            expectation_path,
            provider_uid,
            provider_gid,
            verification_failed: false,
        };
        gate.publish_expectation()?;
        Ok(gate)
    }

    #[cfg(test)]
    fn input_allowed(&self) -> bool {
        self.released
    }

    fn observe(&mut self, observation: OpenCodeAdoptionObservation) -> bool {
        if !self.matches_binding(&observation) {
            return false;
        }
        // A current producer can withdraw its selected route even after the
        // first input. Retain the saved root, but require hydration again before
        // exposing current identity or dispatching another command.
        if !observation.hydrated {
            let changed = self.observation.take().is_some() || self.released;
            self.released = false;
            return changed;
        }
        if self.released || !self.matches(&observation) {
            return false;
        }
        if !self.revalidate_current().unwrap_or(false) || !self.matches(&observation) {
            return false;
        }
        self.observation = Some(observation);
        true
    }

    fn release_input(&mut self) -> bool {
        if self.released {
            return true;
        }
        let Some(observation) = self.observation.clone() else {
            return false;
        };
        if !self.revalidate_current().unwrap_or(false) || !self.matches(&observation) {
            self.observation = None;
            return false;
        }
        self.released = true;
        true
    }

    fn matches_binding(&self, observation: &OpenCodeAdoptionObservation) -> bool {
        observation.terminal_id == self.terminal_id
            && observation.incarnation_id == self.incarnation_id
            && observation.incarnation_id == self.expectation.incarnation_id
            && observation.launch_nonce == self.expectation.launch_nonce
            && observation.root_session_id == self.expectation.root_session_id
            && observation.evidence_generation == self.expectation.evidence_generation
    }

    fn matches(&self, observation: &OpenCodeAdoptionObservation) -> bool {
        if !self.matches_binding(observation) || !observation.hydrated {
            return false;
        }
        match (&self.expectation.root_tail, observation.messages_read) {
            (OpenCodeVerifiedRootTail::Message { message_id }, OpenCodeMessagesRead::Success) => {
                observation.tail_message_id.as_deref() == Some(message_id.as_str())
            }
            (OpenCodeVerifiedRootTail::QualifiedEmpty, OpenCodeMessagesRead::EmptyConfirmed) => {
                observation.tail_message_id.is_none()
            }
            _ => false,
        }
    }

    fn status(&self) -> OpenCodeAdoptionStatus {
        self.observation
            .as_ref()
            .map(|observation| OpenCodeAdoptionStatus::Observed {
                observation: observation.clone(),
            })
            .unwrap_or(OpenCodeAdoptionStatus::AwaitingObservation)
    }

    fn revalidate_current(&mut self) -> Result<bool, String> {
        let current = match (self.verifier)(&self.expectation.baseline) {
            Ok(current) => {
                self.verification_failed = false;
                current
            }
            Err(error) => {
                self.emit_validation_result("warning", "current_store_unavailable");
                self.observation = None;
                self.released = false;
                if !self.verification_failed {
                    self.rotate_nonce();
                    self.publish_expectation()?;
                }
                self.verification_failed = true;
                return Err(error);
            }
        };
        let baseline = &self.expectation.baseline.descriptor;
        if current.version != 1
            || current.transfer_id != baseline.transfer_id
            || current.destination_store_id != baseline.destination_store_id
            || current.import_generation != baseline.source_generation
            || current.root_session_id != self.expectation.root_session_id
            || current.evidence_generation.len() != 64
            || !current
                .evidence_generation
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            self.emit_validation_result("warning", "current_store_identity_mismatch");
            self.observation = None;
            self.released = false;
            if !self.verification_failed {
                self.rotate_nonce();
                self.publish_expectation()?;
            }
            self.verification_failed = true;
            return Err("verified OpenCode store identity does not match its baseline".into());
        }
        let current_tail = match current.root_tail {
            freshell_agent_runtime::opencode_transfer::VerifiedRootTail::Message { message_id } => {
                OpenCodeVerifiedRootTail::Message { message_id }
            }
            freshell_agent_runtime::opencode_transfer::VerifiedRootTail::QualifiedEmpty => {
                OpenCodeVerifiedRootTail::QualifiedEmpty
            }
        };
        if current.evidence_generation != self.expectation.evidence_generation
            || current_tail != self.expectation.root_tail
        {
            self.expectation.evidence_generation = current.evidence_generation;
            self.expectation.root_tail = current_tail;
            self.rotate_nonce();
            self.observation = None;
            self.released = false;
            self.emit_validation_result("info", "current_evidence_changed");
            self.publish_expectation()?;
            return Ok(false);
        }
        self.emit_validation_result("info", "current_store_verified");
        Ok(true)
    }

    fn emit_validation_result(&self, severity: &str, reason: &str) {
        crate::emit_environment_event(serde_json::json!({
            "severity": severity,
            "event": "managed_opencode.current_store_revalidation",
            "terminal_id": self.terminal_id,
            "provider_store_id": self.expectation.baseline.descriptor.destination_store_id,
            "incarnation_id": self.incarnation_id,
            "launch_nonce": self.expectation.launch_nonce,
            "evidence_generation": self.expectation.evidence_generation,
            "reason": reason,
        }));
    }

    fn rotate_nonce(&mut self) {
        self.expectation.launch_nonce = uuid::Uuid::new_v4().simple().to_string();
    }

    fn publish_expectation(&self) -> Result<(), String> {
        publish_opencode_adoption_expectation(
            &self.expectation_path,
            &self.terminal_id,
            &self.expectation,
            self.provider_uid,
            self.provider_gid,
        )
    }
}

impl Drop for OpenCodeAdoptionGate {
    fn drop(&mut self) {
        let _ = with_provider_filesystem_identity(self.provider_uid, self.provider_gid, || {
            remove_opencode_adoption_expectation(&self.expectation_path, &self.incarnation_id);
            Ok(())
        });
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct OpenCodeAdoptionExpectationFile<'a> {
    terminal_id: &'a str,
    root_session_id: &'a str,
    root_tail: &'a OpenCodeVerifiedRootTail,
    evidence_generation: &'a str,
    incarnation_id: &'a IncarnationId,
    launch_nonce: &'a str,
}

fn publish_opencode_adoption_expectation(
    path: &Path,
    terminal_id: &str,
    expectation: &OpenCodeAdoptionExpectation,
    provider_uid: u32,
    provider_gid: u32,
) -> Result<(), String> {
    with_provider_filesystem_identity(provider_uid, provider_gid, || {
        let parent = path
            .parent()
            .ok_or("OpenCode adoption expectation has no parent directory")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        crate::set_mode(parent, 0o700)?;
        let bytes = serde_json::to_vec(&OpenCodeAdoptionExpectationFile {
            terminal_id,
            root_session_id: &expectation.root_session_id,
            root_tail: &expectation.root_tail,
            evidence_generation: &expectation.evidence_generation,
            incarnation_id: &expectation.incarnation_id,
            launch_nonce: &expectation.launch_nonce,
        })
        .map_err(|error| error.to_string())?;
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        match std::fs::symlink_metadata(&temporary) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("OpenCode adoption expectation staging path is not a file".into());
            }
            Ok(_) => std::fs::remove_file(&temporary).map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        crate::set_mode(&temporary, 0o600)?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        Ok(())
    })
}

fn with_provider_filesystem_identity<T>(
    provider_uid: u32,
    provider_gid: u32,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    #[cfg(target_os = "linux")]
    unsafe {
        // libc exposes these return values as signed ints even though Linux
        // filesystem IDs are uid_t/gid_t bit patterns.
        let original_uid = libc::setfsuid(u32::MAX) as u32;
        let original_gid = libc::setfsgid(u32::MAX) as u32;
        libc::setfsgid(provider_gid);
        libc::setfsuid(provider_uid);
        let active_uid = libc::setfsuid(u32::MAX) as u32;
        let active_gid = libc::setfsgid(u32::MAX) as u32;
        if active_uid != provider_uid || active_gid != provider_gid {
            libc::setfsgid(original_gid);
            libc::setfsuid(original_uid);
            return Err("provider filesystem identity is unavailable".into());
        }

        let result = action();
        libc::setfsgid(original_gid);
        libc::setfsuid(original_uid);
        let restored_uid = libc::setfsuid(u32::MAX) as u32;
        let restored_gid = libc::setfsgid(u32::MAX) as u32;
        if restored_uid != original_uid || restored_gid != original_gid {
            return Err("host filesystem identity could not be restored".into());
        }
        result
    }
    #[cfg(not(target_os = "linux"))]
    {
        if unsafe { libc::geteuid() } != provider_uid || unsafe { libc::getegid() } != provider_gid
        {
            return Err("provider filesystem identity is unavailable".into());
        }
        action()
    }
}

fn set_opencode_adoption_environment(
    environment: &mut BTreeMap<String, String>,
    expectation: &OpenCodeAdoptionExpectation,
) {
    environment.insert(
        "FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID".into(),
        expectation.root_session_id.clone(),
    );
    environment.insert(
        "FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION".into(),
        expectation.evidence_generation.clone(),
    );
    environment.insert(
        "FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID".into(),
        expectation.incarnation_id.to_string(),
    );
    environment.insert(
        "FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE".into(),
        expectation.launch_nonce.clone(),
    );
    match &expectation.root_tail {
        OpenCodeVerifiedRootTail::Message { message_id } => {
            environment.insert(
                "FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID".into(),
                message_id.clone(),
            );
            environment.insert(
                "FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY".into(),
                "false".into(),
            );
        }
        OpenCodeVerifiedRootTail::QualifiedEmpty => {
            environment.remove("FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID");
            environment.insert(
                "FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY".into(),
                "true".into(),
            );
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeAdoptionSignalFile {
    #[serde(alias = "session_id")]
    session_id: Option<String>,
    #[serde(alias = "adoption_observation")]
    adoption_observation: Option<OpenCodeAdoptionObservation>,
}

fn spawn_opencode_adoption_signal_relay(
    terminal_id: &str,
    provider_uid: u32,
    provider_gid: u32,
    adoption_gate: Arc<Mutex<OpenCodeAdoptionGate>>,
    native_session_id: Arc<Mutex<Option<String>>>,
    exited: Arc<AtomicBool>,
) -> Result<(), String> {
    let signal_root = PathBuf::from(OPENCODE_ADOPTION_SIGNAL_ROOT);
    let terminal_id = terminal_id.to_string();
    thread::Builder::new()
        .name(format!(
            "opencode-adopt-{}",
            terminal_id.chars().take(12).collect::<String>()
        ))
        .spawn(move || {
            #[cfg(target_os = "linux")]
            unsafe {
                libc::setfsgid(provider_gid);
                libc::setfsuid(provider_uid);
                if libc::setfsuid(u32::MAX) != provider_uid as libc::c_int {
                    tracing::warn!(terminal_id = %terminal_id, provider_uid,
                        "managed_opencode.adoption_relay_identity_unavailable");
                    return;
                }
            }
            while !exited.load(Ordering::SeqCst) {
                process_opencode_adoption_signals(
                    &signal_root,
                    &terminal_id,
                    &adoption_gate,
                    &native_session_id,
                );
                reap_stale_opencode_adoption_files(&signal_root, &terminal_id);
                thread::sleep(Duration::from_millis(250));
            }
            remove_opencode_adoption_expectation_if_owned(
                &signal_root,
                &terminal_id,
                &adoption_gate,
            );
        })
        .map(|_| ())
        .map_err(|error| format!("start OpenCode adoption observation relay: {error}"))
}

fn process_opencode_adoption_signals(
    root: &Path,
    terminal_id: &str,
    adoption_gate: &Arc<Mutex<OpenCodeAdoptionGate>>,
    native_session_id: &Arc<Mutex<Option<String>>>,
) -> usize {
    let mut accepted_count = 0;
    for (path, observation) in opencode_adoption_signals(root, terminal_id) {
        let accepted = adoption_gate
            .lock()
            .map(|mut gate| gate.observe(observation.clone()))
            .unwrap_or(false);
        if accepted {
            accepted_count += 1;
            if let Ok(mut slot) = native_session_id.lock() {
                *slot = Some(observation.root_session_id.clone());
            }
            if observation.hydrated {
                tracing::info!(terminal_id = %terminal_id,
                    root_session_id = %observation.root_session_id,
                    "managed_opencode.provider_observed");
            } else {
                tracing::info!(terminal_id = %terminal_id,
                    root_session_id = %observation.root_session_id,
                    "managed_opencode.provider_observation_withdrawn");
            }
        } else {
            tracing::debug!(terminal_id = %terminal_id,
                "managed_opencode.adoption_observation_rejected");
        }
        let _ = std::fs::remove_file(path);
    }
    accepted_count
}

fn opencode_adoption_signals(
    root: &Path,
    terminal_id: &str,
) -> Vec<(PathBuf, OpenCodeAdoptionObservation)> {
    let prefix = format!("{terminal_id}__");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.starts_with(&prefix) || !name.ends_with(".json") {
                return None;
            }
            Some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    let mut observations = Vec::new();
    for (_, path) in paths {
        if path_is_stale(&path, Duration::from_secs(600)) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let Ok(raw) = std::fs::read(&path) else {
            continue;
        };
        let Ok(signal) = serde_json::from_slice::<OpenCodeAdoptionSignalFile>(&raw) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        let (Some(session_id), Some(observation)) =
            (signal.session_id, signal.adoption_observation)
        else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if session_id == observation.root_session_id {
            observations.push((path, observation));
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
    observations
}

fn reap_stale_opencode_adoption_files(root: &Path, terminal_id: &str) {
    let prefix = format!("{terminal_id}__");
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&prefix) && path_is_stale(&entry.path(), Duration::from_secs(600)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn path_is_stale(path: &Path, max_age: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > max_age)
}

fn remove_opencode_adoption_expectation_if_owned(
    root: &Path,
    terminal_id: &str,
    gate: &Arc<Mutex<OpenCodeAdoptionGate>>,
) {
    let Ok(gate) = gate.lock() else {
        return;
    };
    let path = root.join(format!("{terminal_id}.expected.json"));
    remove_opencode_adoption_expectation(&path, &gate.incarnation_id);
}

fn remove_opencode_adoption_expectation(path: &Path, incarnation_id: &IncarnationId) {
    let Ok(raw) = std::fs::read(path) else {
        return;
    };
    let Ok(file) = serde_json::from_slice::<OpenCodeAdoptionExpectationFileOwned>(&raw) else {
        return;
    };
    if &file.incarnation_id == incarnation_id {
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct OpenCodeAdoptionExpectationFileOwned {
    incarnation_id: IncarnationId,
}

async fn run_codex_native_events(
    mut events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    sidecar: Arc<CodexLaunchSidecar>,
    state_dir: PathBuf,
    expected_session_id: Option<String>,
    native_session_id: Arc<Mutex<Option<String>>>,
    activity: Arc<Mutex<crate::codex_activity::CodexActivityJournal>>,
) {
    while let Some(event) = events.recv().await {
        activity
            .lock()
            .expect("Codex activity journal lock")
            .note_remote_event(&event, epoch_ms());
        let candidate = match event {
            RemoteProxyEvent::Candidate(candidate) => Some(candidate.thread),
            RemoteProxyEvent::ThreadStarted(started) => Some(started.thread),
            _ => None,
        };
        let Some(candidate) = candidate else {
            continue;
        };
        let current = native_session_id
            .lock()
            .ok()
            .and_then(|identity| identity.clone());
        if let Err(message) = validate_codex_candidate(
            expected_session_id.as_deref(),
            current.as_deref(),
            &candidate.id,
            candidate.ephemeral,
        ) {
            let _ = crate::append_event(
                &state_dir,
                "host.codex_identity_rejected",
                serde_json::json!({"candidate":candidate.id,"reason":message}),
            );
            sidecar.fail_candidate_capture(&message).await;
            continue;
        }
        let receipt = serde_json::json!({
            "schemaVersion": 1,
            "provider": "codex",
            "nativeSessionId": candidate.id,
            "ephemeral": false,
            "observedAt": epoch_ms(),
        });
        let encoded = match serde_json::to_vec_pretty(&receipt) {
            Ok(encoded) => encoded,
            Err(error) => {
                sidecar
                    .fail_candidate_capture(&format!("serialize Codex identity receipt: {error}"))
                    .await;
                continue;
            }
        };
        if let Err(error) = crate::atomic_write(&state_dir.join("provider-identity.json"), &encoded)
        {
            sidecar
                .fail_candidate_capture(&format!("persist Codex identity receipt: {error}"))
                .await;
            continue;
        }
        if let Ok(mut identity) = native_session_id.lock() {
            *identity = Some(candidate.id.clone());
        }
        let _ = crate::append_event(
            &state_dir,
            "host.codex_identity_observed",
            serde_json::json!({"nativeSessionId":candidate.id}),
        );
        sidecar.mark_candidate_persisted().await;
    }
}

fn validate_codex_candidate(
    expected: Option<&str>,
    current: Option<&str>,
    candidate: &str,
    ephemeral: bool,
) -> Result<(), String> {
    if ephemeral {
        return Err(format!(
            "Codex candidate {candidate} is ephemeral and cannot establish durable identity"
        ));
    }
    if candidate.is_empty() {
        return Err("Codex returned an empty thread identity".into());
    }
    if let Some(expected) = expected {
        if candidate != expected {
            return Err(format!(
                "Codex resumed wrong thread: expected {expected}, observed {candidate}"
            ));
        }
    }
    if let Some(current) = current {
        if candidate != current {
            return Err(format!(
                "Codex attempted to rebind {current} to competing thread {candidate}"
            ));
        }
    }
    Ok(())
}

fn native_startup_source(mode: &str, args: &[String], has_session_id: bool) -> &'static str {
    // Claude also preallocates fresh UUIDs into resume_session_id. The
    // actual CLI intent determines which SessionStart event must follow.
    let resuming = if mode == "claude" {
        args.iter()
            .any(|arg| arg == "--resume" || arg.starts_with("--resume="))
    } else {
        has_session_id
    };
    if resuming {
        "resume"
    } else {
        "startup"
    }
}

#[cfg(all(test, unix))]
mod native_startup_source_tests {
    use super::native_startup_source;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn publish_claude(
        home: &std::path::Path,
        signal_dir: &std::path::Path,
        launch: &freshell_runtime_protocol::NativeIdentityLaunch,
        root: &str,
        source: &str,
    ) {
        let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../freshell-claude-sidecar/native-session-channel.mjs");
        let transcript = home.join("native.jsonl");
        let cwd = home.to_string_lossy();
        let hook = serde_json::json!({"hook_event_name":"SessionStart", "session_id":root,
            "source":source, "cwd":cwd, "transcript_path":transcript});
        let status = serde_json::json!({"session_id":root,"transcript_path":transcript,
            "version":"2.1.263","model":{"id":"controlled-model"},
            "workspace":{"current_dir":cwd},
            "context_window":{"context_window_size":200000,"current_usage":null}});
        for (option, payload) in [(None, hook), (Some("--status-line"), status)] {
            let mut command = Command::new("node");
            command.arg(&module);
            if let Some(option) = option {
                command.arg(option);
            }
            let mut child = command
                .env("HOME", home)
                .current_dir(home)
                .env(
                    "FRESHELL_NATIVE_IDENTITY_LAUNCH",
                    serde_json::to_string(launch).unwrap(),
                )
                .env("FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR", signal_dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(payload.to_string().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn claude_actual_launch_intent_accepts_only_matching_native_hook_source() {
        let root = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for (flag, emitted_source, accepted) in [
            ("--session-id", "startup", true),
            ("--resume", "resume", true),
            ("--session-id", "resume", false),
            ("--resume", "startup", false),
        ] {
            let owned = tempfile::tempdir().unwrap();
            let signal_dir = owned.path().join("signals");
            let launch = freshell_runtime_protocol::NativeIdentityLaunch {
                incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
                launch_nonce: "current-launch".into(),
                evidence_revision: 0,
                execution_generation: 1,
                requested_native_session_id: Some(root.into()),
            };
            publish_claude(owned.path(), &signal_dir, &launch, root, emitted_source);
            let args = vec![flag.into(), root.into()];
            let observed = crate::providers::native_identity::read_claude_observation(
                &signal_dir.join("session-start.json"),
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
                &launch,
                native_startup_source("claude", &args, true),
                owned.path(),
            )
            .unwrap();
            assert_eq!(observed.is_some(), accepted, "{flag} with {emitted_source}");
        }
    }

    #[tokio::test]
    async fn claude_clear_updates_live_identity_and_keeps_input_ready_after_replacement() {
        use crate::providers::native_identity::{signal_directory, LAUNCH_ENV};
        use freshell_runtime_protocol::{
            CommandState, IncarnationId, NativeIdentityLaunch, RequestId,
        };
        use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};

        let owned = crate::tests::executable_fixture();
        let controlled = owned.path().join("controlled-claude");
        std::fs::write(&controlled, "#!/bin/sh\nexec /usr/bin/cat\n").unwrap();
        std::fs::set_permissions(&controlled, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let cleared = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let cleared_again = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        for replacement in [false, true] {
            let incarnation = IncarnationId::new();
            let current = if replacement { cleared } else { original };
            let next = if replacement { cleared_again } else { cleared };
            let binding = NativeIdentityLaunch {
                incarnation_id: incarnation.clone(),
                launch_nonce: if replacement {
                    "replacement"
                } else {
                    "initial"
                }
                .into(),
                evidence_revision: 1,
                execution_generation: 1,
                requested_native_session_id: Some(current.into()),
            };
            // The controlled executable accepts the ordinary CLI flags and
            // lets the test observe actual PTY input without a model request.
            let args = if replacement {
                vec!["--resume", current]
            } else {
                vec![]
            };
            let launch = serde_json::from_value(serde_json::json!({
                "terminalId":"clear-terminal", "streamId":"clear-stream", "mode":"claude",
                "program":controlled, "args":args, "cwd":owned.path(), "workspacePath":owned.path(),
                "projectKey":"clear", "cols":80, "rows":24,
                "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
                "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
            }))
            .unwrap();
            let mut pty = super::HostedPty::spawn(
                &owned.path().join(&binding.launch_nonce),
                incarnation.clone(),
                &launch,
                BTreeMap::from([(LAUNCH_ENV.into(), serde_json::to_string(&binding).unwrap())]),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            let signals = signal_directory(owned.path(), &binding).unwrap();
            let source = if replacement { "resume" } else { "startup" };
            publish_claude(owned.path(), &signals, &binding, current, source);
            let initial_input = pty.write_input(&RequestId::new(), "initial input\n");
            let mut foreign = binding.clone();
            foreign.launch_nonce = "another-process".into();
            publish_claude(owned.path(), &signals, &foreign, next, "clear");
            let foreign_input = pty.write_input(&RequestId::new(), "foreign input\n");
            publish_claude(owned.path(), &signals, &binding, next, source);
            let unrelated_input = pty.write_input(&RequestId::new(), "unrelated input\n");
            publish_claude(owned.path(), &signals, &binding, next, "clear");
            let observed = pty.native_identity_observation();
            let next_input = pty.write_input(&RequestId::new(), "input after clear\n");
            publish_claude(owned.path(), &signals, &binding, next, "compact");
            let compact_input = pty.write_input(&RequestId::new(), "input after compact\n");
            let output = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let output = pty
                        .read_output(incarnation.clone(), 0, 65_536, None)
                        .unwrap();
                    let text = output
                        .frames
                        .iter()
                        .map(|frame| frame.data.as_str())
                        .collect::<String>();
                    if text.contains("input after compact") {
                        break (output, text);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await;
            pty.stop().await;
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while !pty.exited() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();

            assert_eq!(initial_input.unwrap(), CommandState::Completed);
            assert!(
                foreign_input.is_err(),
                "a clear from another launch cannot route input"
            );
            assert!(
                unrelated_input.is_err(),
                "a different root without a clear is not a transition"
            );
            let observed = observed.expect("clear must qualify the current root");
            assert_eq!(observed.native_session_id, next);
            assert!(observed.matches_launch(&binding));
            assert_eq!(next_input.unwrap(), CommandState::Completed);
            assert_eq!(compact_input.unwrap(), CommandState::Completed);
            let (output, text) = output.expect("actual accepted input reaches the controlled PTY");
            assert_eq!(output.native_session_id.as_deref(), Some(next));
            assert!(text.contains("initial input") && text.contains("input after clear"));
            assert!(!text.contains("foreign input") && !text.contains("unrelated input"));
        }
    }

    #[tokio::test]
    async fn native_output_reads_current_producer_without_legacy_cache_fallback() {
        use crate::providers::native_identity::{signal_directory, LAUNCH_ENV};
        let owned = tempfile::tempdir().unwrap();
        let incarnation = freshell_runtime_protocol::IncarnationId::new();
        let root = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let binding = freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: incarnation.clone(),
            launch_nonce: "owned-output-launch".into(),
            evidence_revision: 0,
            execution_generation: 1,
            requested_native_session_id: Some(root.into()),
        };
        let launch = serde_json::from_value(serde_json::json!({
            "terminalId":"owned-output", "streamId":"owned-output", "mode":"claude",
            "program":"/usr/bin/cat", "args":[], "cwd":owned.path(), "workspacePath":owned.path(),
            "projectKey":"owned-output", "cols":80, "rows":24,
            "runAsUid":unsafe {libc::geteuid()}, "runAsGid":unsafe {libc::getegid()},
            "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
        }))
        .unwrap();
        let mut pty = super::HostedPty::spawn(
            &owned.path().join("state"),
            incarnation.clone(),
            &launch,
            std::collections::BTreeMap::from([(
                LAUNCH_ENV.into(),
                serde_json::to_string(&binding).unwrap(),
            )]),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let signal_dir = signal_directory(owned.path(), &binding).unwrap();
        let output_identity = |pty: &super::HostedPty| {
            pty.read_output(incarnation.clone(), 0, 65536, None)
                .unwrap()
                .native_session_id
        };
        assert_eq!(
            output_identity(&pty),
            None,
            "no producer acknowledgement yet"
        );
        publish_claude(owned.path(), &signal_dir, &binding, root, "startup");
        assert_eq!(
            pty.native_identity_observation().unwrap().native_session_id,
            root
        );
        assert_eq!(
            output_identity(&pty).as_deref(),
            Some(root),
            "qualified producer reaches output"
        );
        *pty.native_session_id.lock().unwrap() = Some("stale-legacy-root".into());
        std::fs::remove_file(signal_dir.join("session-start.json")).unwrap();
        assert_eq!(
            output_identity(&pty),
            None,
            "withdrawn proof cannot use stale cache"
        );
        let mut foreign = binding.clone();
        foreign.launch_nonce = "foreign-launch".into();
        publish_claude(owned.path(), &signal_dir, &foreign, root, "startup");
        assert_eq!(
            output_identity(&pty),
            None,
            "another launch cannot use stale cache"
        );
        publish_claude(owned.path(), &signal_dir, &binding, root, "resume");
        assert_eq!(
            output_identity(&pty),
            None,
            "wrong hook source cannot use stale cache"
        );
        publish_claude(owned.path(), &signal_dir, &binding, root, "startup");
        assert_eq!(output_identity(&pty).as_deref(), Some(root));
        pty.native_identity_launch = None;
        assert_eq!(
            output_identity(&pty).as_deref(),
            Some("stale-legacy-root"),
            "ordinary cache behavior preserved"
        );
        pty.native_identity_launch = Some(binding);
        pty.stop().await;
        for _ in 0..100 {
            if pty.exited() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(pty.exited(), "owned PTY stopped");
        assert_eq!(
            output_identity(&pty),
            None,
            "exited native producer cannot use stale cache"
        );
    }
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn select_opencode_session(
    rows: &[OpencodeSessionRow],
    cwd: &str,
    floor_ms: i64,
) -> Option<String> {
    let mut matches = rows.iter().filter(|row| {
        row.has_three_views_marker != Some(1)
            && row.created_at.is_some_and(|created| created >= floor_ms)
            && row
                .cwd
                .as_deref()
                .is_some_and(|candidate| paths_equivalent(candidate, cwd))
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first.session_id.clone())
}

fn output_read_position(
    current_stream_epoch: &str,
    expected_stream_epoch: Option<&str>,
    after_seq: u64,
) -> (u64, bool) {
    let source_changed = expected_stream_epoch.is_some_and(|epoch| epoch != current_stream_epoch);
    (if source_changed { 0 } else { after_seq }, source_changed)
}

#[cfg(test)]
mod output_epoch_tests {
    use super::output_read_position;

    async fn retained_pty(
        root: &std::path::Path,
        script: &str,
    ) -> (super::HostedPty, freshell_runtime_protocol::IncarnationId) {
        let launch:super::TerminalLaunchSpec=serde_json::from_value(serde_json::json!({
            "terminalId":"retained-pty","streamId":"launch-prefix","mode":"shell","program":"/bin/sh",
            "args":["-c",script],"env":{"PATH":"/usr/bin:/bin"},"cwd":root,
            "runAsUid":unsafe {libc::geteuid()},"runAsGid":unsafe {libc::getegid()},
            "cols":120,"rows":30,"projectKey":"retained-fixture","workspacePath":root
        })).unwrap();
        let incarnation = freshell_runtime_protocol::IncarnationId::new();
        (
            super::HostedPty::spawn(
                root,
                incarnation.clone(),
                &launch,
                Default::default(),
                None,
                None,
                None,
            )
            .await
            .unwrap(),
            incarnation,
        )
    }

    #[tokio::test]
    async fn retained_output_pty_eof_flushes_final_head_before_completion() {
        let root = tempfile::tempdir().unwrap();
        let (hosted, incarnation) = retained_pty(
            root.path(),
            "head -c 150000 /dev/zero | tr '\\000' 'x'; printf 'final-tail'; exit 17",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !hosted.exited() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let completion = std::fs::read(root.path().join("terminal-spool-completion.json"));
        let mut windows = vec![];
        let head = hosted.head_seq();
        for _reader in 0..2 {
            let mut cursor = 0;
            let mut window = String::new();
            while cursor < head {
                let batch = hosted
                    .read_output(
                        incarnation.clone(),
                        cursor,
                        65536,
                        Some(hosted.stream_epoch()),
                    )
                    .unwrap();
                assert!(batch.exited);
                assert_eq!(batch.head_seq, head);
                assert_eq!(batch.exit_code, Some(17));
                for frame in batch.frames {
                    cursor = frame.seq_end;
                    window.push_str(&frame.data);
                }
            }
            windows.push(window);
        }
        drop(hosted); // actual PTY waiter and reader join before assertions
        assert_eq!(windows[0], "x".repeat(150000) + "final-tail");
        assert_eq!(windows[0], windows[1]);
        let completion: serde_json::Value = serde_json::from_slice(
            &completion.expect("settled EOF publishes coherent durable completion"),
        )
        .unwrap();
        assert_eq!(completion["headSeq"], head);
        assert!(completion["streamEpoch"]
            .as_str()
            .unwrap()
            .starts_with("launch-prefix-hostboot-"));
        assert_eq!(completion["exit"]["code"], 17);
    }

    #[tokio::test]
    async fn retained_output_failure_does_not_hide_provider_exit() {
        let root = tempfile::tempdir().unwrap();
        let (hosted, incarnation) = retained_pty(root.path(), "sleep 0.1; exit 23").await;
        hosted.output.lock().unwrap().record_failure();

        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !hosted.exited() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("journal completion failure must not leave an exited provider reported live");

        assert_eq!(hosted.exit_code(), 23);
        let output_error = hosted
            .read_output(incarnation, 0, 65536, Some(hosted.stream_epoch()))
            .expect_err("the failed retained-output journal remains unavailable");
        assert_eq!(
            output_error.code,
            freshell_runtime_protocol::RuntimeErrorCode::HostUnreachable
        );
    }

    #[tokio::test]
    async fn retained_output_successful_stop_joins_reader_before_reply() {
        let root = tempfile::tempdir().unwrap();
        let (mut hosted, _) = retained_pty(root.path(), "printf 'stop-tail'; sleep 300").await;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while hosted.head_seq() == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        hosted.stop().await;
        let exited = hosted.exited();
        let completion = std::fs::read(root.path().join("terminal-spool-completion.json"));
        drop(hosted);
        assert!(
            exited,
            "successful Stop settles the output reader before returning"
        );
        assert!(
            completion.is_ok(),
            "successful Stop freezes a retained completion before reply"
        );
    }

    #[test]
    fn obsolete_source_epoch_forces_one_call_full_replay() {
        assert_eq!(
            output_read_position("new-host", Some("old-host"), 206),
            (0, true)
        );
    }

    #[test]
    fn matching_or_legacy_callers_preserve_their_cursor() {
        assert_eq!(
            output_read_position("same-host", Some("same-host"), 206),
            (206, false)
        );
        assert_eq!(output_read_position("same-host", None, 206), (206, false));
    }
}

fn paths_equivalent(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left = std::fs::canonicalize(left).ok();
    let right = std::fs::canonicalize(right).ok();
    left.is_some() && left == right
}

fn spawn_opencode_identity_watcher(
    launch: &TerminalLaunchSpec,
    floor_ms: i64,
    native_session_id: Arc<Mutex<Option<String>>>,
    _exited: Arc<AtomicBool>,
) {
    let data_home = launch
        .env
        .get("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/home/freshell/provider/.local/share"))
        .join("opencode");
    let cwd = launch.cwd.clone();
    let terminal_id = launch.terminal_id.clone();
    let uid = launch.run_as_uid;
    let gid = launch.run_as_gid;
    let Ok(exe) = std::env::current_exe() else {
        tracing::warn!(terminal_id = %terminal_id, "managed_opencode.identity_helper_exe_unavailable");
        return;
    };
    let _ = thread::Builder::new()
        .name(format!(
            "opencode-id-{}",
            terminal_id.chars().take(12).collect::<String>()
        ))
        .spawn(move || {
            let mut command = std::process::Command::new("/usr/bin/setpriv");
            command
                .arg("--reuid")
                .arg(uid.to_string())
                .arg("--regid")
                .arg(gid.to_string())
                .arg("--clear-groups")
                .arg("--no-new-privs")
                .arg("--")
                .arg(exe)
                .arg("opencode-identity-worker")
                .arg("--data-home")
                .arg(data_home)
                .arg("--cwd")
                .arg(cwd)
                .arg("--floor-ms")
                .arg(floor_ms.to_string())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            match command.output() {
                Ok(output) if output.status.success() => {
                    let session_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if session_id.starts_with("ses_") {
                        if let Ok(mut slot) = native_session_id.lock() {
                            if slot.is_none() {
                                *slot = Some(session_id.clone());
                            }
                        }
                        tracing::info!(terminal_id = %terminal_id, session_id = %session_id,
                            "managed_opencode.native_session_discovered");
                    }
                }
                Ok(output) => {
                    tracing::debug!(terminal_id = %terminal_id, status = ?output.status.code(),
                    "managed_opencode.identity_helper_exited_without_identity")
                }
                Err(error) => tracing::warn!(terminal_id = %terminal_id, error = %error,
                    "managed_opencode.identity_helper_spawn_failed"),
            }
        });
}

/// The TUI plugin writes switch signals inside the soul's provider home.
/// Relay the latest observed native id through the existing output batch,
/// which the host associates with its pane using the normal guard ladder.
fn spawn_opencode_signal_relay(
    terminal_id: &str,
    provider_uid: u32,
    provider_gid: u32,
    native_session_id: Arc<Mutex<Option<String>>>,
    exited: Arc<AtomicBool>,
) {
    let signal_root = PathBuf::from("/home/freshell/provider/.freshell/session-signals/opencode");
    let terminal_id = terminal_id.to_string();
    let _ = thread::Builder::new()
        .name(format!(
            "opencode-signal-{}",
            terminal_id.chars().take(12).collect::<String>()
        ))
        .spawn(move || {
            // The provider HOME is 0700 and this trusted host intentionally
            // lacks DAC_OVERRIDE. Set the filesystem identity on this
            // dedicated reader thread so it can see the provider's signals.
            #[cfg(target_os = "linux")]
            unsafe {
                libc::setfsgid(provider_gid);
                libc::setfsuid(provider_uid);
                if libc::setfsuid(u32::MAX) != provider_uid as libc::c_int {
                    tracing::warn!(terminal_id = %terminal_id, provider_uid,
                        "managed_opencode.signal_relay_identity_unavailable");
                    return;
                }
            }
            let mut last_file = None;
            while !exited.load(Ordering::SeqCst) {
                if let Some((name, session_id)) = latest_opencode_signal(&signal_root, &terminal_id)
                {
                    if last_file.as_deref() != Some(name.as_str()) {
                        if let Ok(mut slot) = native_session_id.lock() {
                            *slot = Some(session_id.clone());
                        }
                        tracing::info!(terminal_id = %terminal_id, session_id = %session_id,
                            "managed_opencode.signal_relayed");
                        last_file = Some(name);
                    }
                }
                thread::sleep(Duration::from_millis(250));
            }
        });
}

fn latest_opencode_signal(root: &Path, terminal_id: &str) -> Option<(String, String)> {
    let prefix = format!("{terminal_id}__");
    let mut signals = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.starts_with(&prefix) || !name.ends_with(".json") {
                return None;
            }
            Some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    signals.sort_by(|left, right| right.0.cmp(&left.0));
    for (name, path) in signals {
        let Ok(raw) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if session_id
            .strip_prefix("ses_")
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        {
            return Some((name, session_id.to_string()));
        }
    }
    None
}

pub(crate) fn run_opencode_identity_worker(args: &[String]) -> Result<(), String> {
    let data_home = worker_arg(args, "--data-home")?;
    let cwd = worker_arg(args, "--cwd")?;
    let floor_ms: i64 = worker_arg(args, "--floor-ms")?
        .parse()
        .map_err(|error| format!("invalid --floor-ms: {error}"))?;
    let provider = OpencodeProvider::new(PathBuf::from(data_home));
    // A provider can sit idle before its first turn, so this helper is allowed
    // to wait. It lives inside the soul cgroup and disappears with the enclosure.
    for _ in 0..14_400 {
        match provider.list_sessions_since(floor_ms, 32) {
            Ok(rows) => {
                if let Some(session_id) = select_opencode_session(&rows, &cwd, floor_ms) {
                    println!("{session_id}");
                    return Ok(());
                }
            }
            Err(error) => {
                tracing::debug!(error = %error, "managed_opencode.identity_worker_deferred")
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("timed out waiting for OpenCode native session identity".into())
}

fn worker_arg(args: &[String], name: &str) -> Result<String, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .ok_or_else(|| format!("missing {name}"))
}

#[cfg(test)]
mod managed_opencode_identity_tests {
    use super::{latest_opencode_signal, select_opencode_session};
    use freshell_sessions::parse::opencode::OpencodeSessionRow;

    fn row(id: &str, cwd: &str, created_at: i64) -> OpencodeSessionRow {
        OpencodeSessionRow {
            session_id: id.to_string(),
            cwd: Some(cwd.to_string()),
            title: None,
            created_at: Some(created_at),
            last_activity_at: Some(created_at),
            project_path: Some(cwd.to_string()),
            has_three_views_marker: Some(0),
            model: None,
        }
    }

    #[test]
    fn signal_relay_selects_latest_valid_switch_for_its_terminal() {
        let root = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("term__000001.json", r#"{"session_id":"ses_First"}"#),
            ("term__000002.json", r#"{"session_id":"ses_Second"}"#),
            ("term__000003.json", r#"{"hello":true}"#),
            ("other__000004.json", r#"{"session_id":"ses_Foreign"}"#),
        ] {
            std::fs::write(root.path().join(name), body).unwrap();
        }
        assert_eq!(
            latest_opencode_signal(root.path(), "term"),
            Some(("term__000002.json".into(), "ses_Second".into()))
        );
    }

    #[test]
    fn selects_exactly_one_new_matching_root_session_and_refuses_ambiguity() {
        let rows = vec![
            row("ses_old", "/repo", 900),
            row("ses_other", "/other", 1_100),
            row("ses_new", "/repo", 1_200),
        ];
        assert_eq!(
            select_opencode_session(&rows, "/repo", 1_000),
            Some("ses_new".into())
        );

        let ambiguous = vec![row("ses_a", "/repo", 1_100), row("ses_b", "/repo", 1_200)];
        assert_eq!(select_opencode_session(&ambiguous, "/repo", 1_000), None);
    }
}

#[cfg(test)]
mod managed_opencode_adoption_tests {
    use super::{
        begin_input_after_gate, process_opencode_adoption_signals, OpenCodeAdoptionGate,
        OpenCodeAdoptionRevalidator,
    };
    use crate::command_journal::CommandJournal;
    use freshell_agent_runtime::opencode_transfer::{CurrentOpenCodeEvidence, VerifiedRootTail};
    use freshell_runtime_protocol::{
        opencode_target_build_receipt, opencode_transfer_bundle_digest, IncarnationId,
        OpenCodeAdoptionBaseline, OpenCodeAdoptionExpectation, OpenCodeAdoptionObservation,
        OpenCodeMessagesRead, OpenCodeTransferDescriptor, OpenCodeTransferFile,
        OpenCodeVerifiedRootTail, RequestId, RuntimeErrorCode,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    fn descriptor() -> OpenCodeTransferDescriptor {
        use sha2::{Digest, Sha256};

        let root_session_id = "ses_exactroot";
        let source_store_id = "c".repeat(64);
        let source_generation = "d".repeat(64);
        let source_schema_fingerprint = "e".repeat(64);
        let migration_journal_fingerprint = "f".repeat(64);
        let payload = b"x";
        let payload_sha256 = hex::encode(Sha256::digest(payload));
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": root_session_id,
            "source_store_id": source_store_id,
            "source_schema_fingerprint": source_schema_fingerprint,
            "migration_journal_fingerprint": migration_journal_fingerprint,
            "sqlite_version": "test",
            "row_count": 0,
            "rows": [],
            "assets": [],
            "payload_bytes": payload.len(),
            "payload_sha256": payload_sha256,
            "generation": source_generation,
        })
        .to_string();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: payload.len() as u64,
            sha256: payload_sha256,
        }];
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: "transfer-adoption-test".into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: root_session_id.into(),
            source_generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "store-adoption-test".into(),
            destination_database_path: ".local/share/opencode/opencode.db".into(),
            target_image_ref: target_image_ref.clone(),
            target_build_receipt: opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            incarnation_id: "incarnation-import".into(),
            manifest_json,
            files,
            total_bytes: payload.len() as u64,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 =
            opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
        descriptor.validate().unwrap();
        descriptor
    }

    fn expectation(root_tail: OpenCodeVerifiedRootTail) -> OpenCodeAdoptionExpectation {
        let baseline_descriptor = descriptor();
        let manifest_sha256 = {
            use sha2::{Digest, Sha256};
            hex::encode(Sha256::digest(baseline_descriptor.manifest_json.as_bytes()))
        };
        OpenCodeAdoptionExpectation {
            baseline: OpenCodeAdoptionBaseline {
                descriptor: baseline_descriptor,
                manifest_sha256,
            },
            root_session_id: "ses_exactroot".into(),
            root_tail,
            evidence_generation: "a".repeat(64),
            incarnation_id: IncarnationId::parse("incarnation-opencode-adoption").unwrap(),
            launch_nonce: "b".repeat(32),
        }
    }

    fn observation(expectation: &OpenCodeAdoptionExpectation) -> OpenCodeAdoptionObservation {
        let (tail_message_id, messages_read) = match &expectation.root_tail {
            OpenCodeVerifiedRootTail::Message { message_id } => {
                (Some(message_id.clone()), OpenCodeMessagesRead::Success)
            }
            OpenCodeVerifiedRootTail::QualifiedEmpty => {
                (None, OpenCodeMessagesRead::EmptyConfirmed)
            }
        };
        OpenCodeAdoptionObservation {
            terminal_id: "terminal-opencode-adoption".into(),
            root_session_id: expectation.root_session_id.clone(),
            tail_message_id,
            evidence_generation: expectation.evidence_generation.clone(),
            incarnation_id: expectation.incarnation_id.clone(),
            launch_nonce: expectation.launch_nonce.clone(),
            hydrated: true,
            messages_read,
        }
    }

    fn evidence(
        expectation: &OpenCodeAdoptionExpectation,
        generation: &str,
        tail: OpenCodeVerifiedRootTail,
    ) -> CurrentOpenCodeEvidence {
        CurrentOpenCodeEvidence {
            saved_snapshot_summary: Default::default(),
            version: 1,
            transfer_id: expectation.baseline.descriptor.transfer_id.clone(),
            destination_store_id: expectation.baseline.descriptor.destination_store_id.clone(),
            root_session_id: expectation.root_session_id.clone(),
            import_generation: expectation.baseline.descriptor.source_generation.clone(),
            evidence_generation: generation.to_owned(),
            root_tail: match tail {
                OpenCodeVerifiedRootTail::Message { message_id } => {
                    VerifiedRootTail::Message { message_id }
                }
                OpenCodeVerifiedRootTail::QualifiedEmpty => VerifiedRootTail::QualifiedEmpty,
            },
            row_count: 0,
            asset_count: 0,
        }
    }

    fn gate_with_evidence(
        expectation: OpenCodeAdoptionExpectation,
        initial: CurrentOpenCodeEvidence,
    ) -> (
        OpenCodeAdoptionGate,
        Arc<Mutex<CurrentOpenCodeEvidence>>,
        Arc<AtomicUsize>,
        tempfile::TempDir,
    ) {
        let current = Arc::new(Mutex::new(initial));
        let calls = Arc::new(AtomicUsize::new(0));
        let verifier_current = Arc::clone(&current);
        let verifier_calls = Arc::clone(&calls);
        let verifier: OpenCodeAdoptionRevalidator = Arc::new(move |baseline| {
            verifier_calls.fetch_add(1, Ordering::SeqCst);
            baseline.validate().map_err(|error| error.message)?;
            Ok(verifier_current.lock().unwrap().clone())
        });
        let signal_root = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let gate = OpenCodeAdoptionGate::new(
            "terminal-opencode-adoption".into(),
            expectation.incarnation_id.clone(),
            expectation,
            verifier,
            signal_root.path().to_path_buf(),
            uid,
            gid,
        )
        .unwrap();
        (gate, current, calls, signal_root)
    }

    #[cfg(unix)]
    #[test]
    fn adoption_expectation_is_provider_owned_private_and_removed_with_gate() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let expected = expectation(OpenCodeVerifiedRootTail::QualifiedEmpty);
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (gate, _, _, signal_root) = gate_with_evidence(expected, initial);
        let path = signal_root
            .path()
            .join("terminal-opencode-adoption.expected.json");
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(metadata.gid(), unsafe { libc::getegid() });
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);

        drop(gate);
        assert!(
            !path.exists(),
            "dropping the gate removes its owned expectation"
        );
    }

    #[test]
    fn requested_resume_and_route_only_signal_do_not_release_input() {
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, _, calls, _) = gate_with_evidence(expected.clone(), initial);

        // The requested id is already known to the launcher, but no TUI
        // observation has established that this process loaded that session.
        assert!(!gate.input_allowed());

        let mut route_only = observation(&expected);
        route_only.hydrated = false;
        assert!(!gate.observe(route_only));
        assert!(!gate.input_allowed());
        assert!(gate.observe(observation(&expected)));
        assert!(!gate.input_allowed());
        assert!(gate.release_input());
        assert!(gate.input_allowed());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(gate.release_input());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn adopted_route_withdrawal_revokes_identity_and_input_after_first_dispatch() {
        let expected = expectation(OpenCodeVerifiedRootTail::QualifiedEmpty);
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (gate, _, _, signal_root) = gate_with_evidence(expected.clone(), initial);
        let gate = Arc::new(Mutex::new(gate));
        let owned = tempfile::tempdir().unwrap();
        let history = owned.path().join("saved-native-history");
        std::fs::write(&history, "original imported history").unwrap();
        let launch = serde_json::from_value(serde_json::json!({
            "terminalId":"terminal-opencode-adoption", "streamId":"adoption-withdrawal", "mode":"shell",
            "program":"/usr/bin/python3", "args":["-c", "import sys\nf=open('received-input', 'ab', buffering=0)\nfor line in sys.stdin.buffer: f.write(line)"],
            "cwd":owned.path(), "workspacePath":owned.path(), "projectKey":"adoption-withdrawal",
            "cols":80,"rows":24,"runAsUid":unsafe {libc::geteuid()},"runAsGid":unsafe {libc::getegid()},
            "env":{"HOME":owned.path(),"PATH":"/usr/bin:/bin"}
        })).unwrap();
        let mut hosted = super::HostedPty::spawn(
            &owned.path().join("state"),
            expected.incarnation_id.clone(),
            &launch,
            Default::default(),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        hosted.provider_mode = "opencode".into();
        hosted.native_identity_launch = Some(freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: expected.incarnation_id.clone(),
            launch_nonce: "identity-launch".into(),
            evidence_revision: 0,
            execution_generation: 1,
            requested_native_session_id: Some(expected.root_session_id.clone()),
        });
        hosted.opencode_adoption = Some(gate.clone());
        let native_session_id = hosted.native_session_id.clone();
        let publish = |name: &str, value: OpenCodeAdoptionObservation| {
            std::fs::write(signal_root.path().join(format!("terminal-opencode-adoption__{name}.json")),
                serde_json::to_vec(&serde_json::json!({"session_id":value.root_session_id,"adoption_observation":value})).unwrap()).unwrap();
            process_opencode_adoption_signals(
                signal_root.path(),
                "terminal-opencode-adoption",
                &gate,
                &native_session_id,
            )
        };
        assert!(hosted.native_identity_observation().is_none());
        assert_eq!(publish("initial", observation(&expected)), 1);
        hosted.write_input(&RequestId::new(), "first\n").unwrap();
        hosted.write_input(&RequestId::new(), "second\n").unwrap();
        assert!(hosted.native_identity_observation().is_some());
        let mut withdrawal = observation(&expected);
        withdrawal.hydrated = false;
        withdrawal.messages_read = OpenCodeMessagesRead::Failed;
        let mut stale = withdrawal.clone();
        stale.launch_nonce = "older-launch".into();
        assert_eq!(publish("stale", stale), 0);
        assert!(hosted.native_identity_observation().is_some());
        assert_eq!(publish("withdrawn", withdrawal), 1);
        let withdrawn_identity = hosted.native_identity_observation();
        let withdrawn_output = hosted
            .read_output(expected.incarnation_id.clone(), 0, 65536, None)
            .unwrap();
        let retry = RequestId::new();
        let refused = hosted.write_input(&retry, "restored\n");
        let claimed = hosted
            .commands
            .existing_disposition(&retry, b"restored\n")
            .unwrap();
        assert_eq!(publish("restored", observation(&expected)), 1);
        hosted.write_input(&retry, "restored\n").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while std::fs::read(owned.path().join("received-input")).unwrap_or_default()
                != b"first\nsecond\nrestored\n"
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        hosted.stop().await;
        assert!(withdrawn_identity.is_none());
        assert!(withdrawn_output.native_session_id.is_none());
        assert_eq!(refused.unwrap_err().code, RuntimeErrorCode::RecoveryBlocked);
        assert!(
            claimed.is_none(),
            "withdrawn input stays undispatched and retryable"
        );
        assert_eq!(
            hosted.native_session_id().as_deref(),
            Some(expected.root_session_id.as_str())
        );
        assert_eq!(
            std::fs::read_to_string(history).unwrap(),
            "original imported history"
        );
    }

    #[test]
    fn every_adoption_binding_and_fresh_hydrated_tail_must_match() {
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, _, _, _) = gate_with_evidence(expected.clone(), initial);

        let mut stale_or_mismatched = Vec::new();
        let mut candidate = observation(&expected);
        candidate.terminal_id = "another-terminal".into();
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.incarnation_id = IncarnationId::parse("incarnation-older-launch").unwrap();
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.launch_nonce = "c".repeat(32);
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.evidence_generation = "d".repeat(64);
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.root_session_id = "ses_wrong_root".into();
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.tail_message_id = Some("msg_old_tail".into());
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.hydrated = false;
        stale_or_mismatched.push(candidate);
        let mut candidate = observation(&expected);
        candidate.messages_read = OpenCodeMessagesRead::Failed;
        stale_or_mismatched.push(candidate);

        for candidate in stale_or_mismatched {
            assert!(!gate.observe(candidate));
            assert!(!gate.input_allowed());
        }

        assert!(gate.observe(observation(&expected)));
        assert!(!gate.input_allowed());
        assert!(gate.release_input());
        assert!(gate.input_allowed());
    }

    #[test]
    fn empty_root_requires_explicit_successful_empty_read() {
        let expected = expectation(OpenCodeVerifiedRootTail::QualifiedEmpty);
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, _, _, _) = gate_with_evidence(expected.clone(), initial);

        let mut failed_read = observation(&expected);
        failed_read.tail_message_id = None;
        failed_read.messages_read = OpenCodeMessagesRead::Failed;
        assert!(!gate.observe(failed_read));
        assert!(!gate.input_allowed());

        let mut false_empty = observation(&expected);
        false_empty.tail_message_id = None;
        false_empty.messages_read = OpenCodeMessagesRead::Success;
        assert!(!gate.observe(false_empty));
        assert!(!gate.input_allowed());

        let mut positive_empty = observation(&expected);
        positive_empty.tail_message_id = None;
        positive_empty.messages_read = OpenCodeMessagesRead::EmptyConfirmed;
        assert!(gate.observe(positive_empty));
        assert!(!gate.input_allowed());
        assert!(gate.release_input());
        assert!(gate.input_allowed());
    }

    #[test]
    fn changed_generation_rotates_expectation_and_requires_a_fresh_observation() {
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, current, calls, signal_root) = gate_with_evidence(expected.clone(), initial);
        let old_observation = observation(&expected);
        assert!(gate.observe(old_observation.clone()));

        let new_tail = OpenCodeVerifiedRootTail::Message {
            message_id: "msg_new_tail".into(),
        };
        let new_generation = "c".repeat(64);
        *current.lock().unwrap() = evidence(&expected, &new_generation, new_tail.clone());
        assert!(!gate.release_input());
        assert!(!gate.input_allowed());
        assert!(gate.observation.is_none());
        assert_eq!(gate.expectation.evidence_generation, new_generation);
        assert_eq!(gate.expectation.root_tail, new_tail);
        assert_ne!(gate.expectation.launch_nonce, expected.launch_nonce);

        let published: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                signal_root
                    .path()
                    .join("terminal-opencode-adoption.expected.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(published["evidence_generation"], new_generation);
        assert_eq!(published["launch_nonce"], gate.expectation.launch_nonce);
        assert!(!gate.observe(old_observation));

        let fresh_observation = observation(&gate.expectation);
        assert!(gate.observe(fresh_observation));
        assert!(gate.release_input());
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn current_store_revalidation_emits_bound_body_free_results() {
        const CHILD_ENV: &str = "FRESHELL_OPENCODE_GATE_EVENT_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "pty::managed_opencode_adoption_tests::current_store_revalidation_emits_bound_body_free_results", "--nocapture"])
                .env(CHILD_ENV, "1").output().unwrap();
            assert!(output.status.success(), "owned behavioral child must pass");
            let stderr = String::from_utf8(output.stderr).unwrap();
            assert!(!stderr.contains("private-reader-payload"));
            let events = stderr
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter(|event| event["event"] == "managed_opencode.current_store_revalidation")
                .collect::<Vec<_>>();
            assert_eq!(
                events.len(),
                4,
                "actual verifier transitions must be diagnosable"
            );
            assert_eq!(
                events
                    .iter()
                    .map(|event| event["reason"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "current_store_verified",
                    "current_evidence_changed",
                    "current_store_verified",
                    "current_store_unavailable"
                ]
            );
            for event in &events {
                assert_eq!(event["terminal_id"], "terminal-opencode-adoption");
                assert_eq!(event["incarnation_id"], "incarnation-opencode-adoption");
                assert!(event["launch_nonce"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()));
                assert_eq!(event["evidence_generation"].as_str().unwrap().len(), 64);
            }
            assert_eq!(events[3]["severity"], "warning");
            return;
        }
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, current, _, _owned_signal_root) =
            gate_with_evidence(expected.clone(), initial);
        assert!(gate.observe(observation(&expected)));
        *current.lock().unwrap() = evidence(&expected, &"c".repeat(64), expected.root_tail.clone());
        assert!(!gate.release_input());
        assert!(gate.observation.is_none());
        assert!(gate.observe(observation(&gate.expectation)));
        gate.verifier = Arc::new(|_| Err("private-reader-payload".into()));
        assert!(!gate.observe(observation(&gate.expectation)));
        assert!(gate.observation.is_none());
        assert!(!gate.input_allowed());
    }

    #[test]
    fn blocked_input_does_not_claim_request_and_same_request_retries_after_observation() {
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (mut gate, _, _, _) = gate_with_evidence(expected.clone(), initial);
        let state_dir = tempfile::tempdir().unwrap();
        let mut journal = CommandJournal::open(state_dir.path()).unwrap();
        let request_id = RequestId::new();

        let error = begin_input_after_gate(&mut journal, &request_id, b"resume input", || {
            Ok(gate.release_input())
        })
        .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);
        assert!(!state_dir.path().join("command-journal.json").exists());

        assert!(gate.observe(observation(&expected)));
        assert_eq!(
            begin_input_after_gate(&mut journal, &request_id, b"resume input", || {
                Ok(gate.release_input())
            })
            .unwrap(),
            super::BeginDisposition::Dispatch
        );
        assert_eq!(
            journal
                .existing_disposition(&request_id, b"resume input")
                .unwrap(),
            Some(super::BeginDisposition::Dispatch)
        );
    }

    #[test]
    fn stale_later_filename_does_not_mask_current_nonce_observation() {
        let expected = expectation(OpenCodeVerifiedRootTail::Message {
            message_id: "msg_current_tail".into(),
        });
        let initial = evidence(
            &expected,
            &expected.evidence_generation,
            expected.root_tail.clone(),
        );
        let (gate, _, _, _) = gate_with_evidence(expected.clone(), initial);
        let gate = Arc::new(Mutex::new(gate));
        let native_session_id = Arc::new(Mutex::new(None));
        let current = observation(&expected);
        let mut stale = current.clone();
        stale.launch_nonce = "c".repeat(32);
        let root = tempfile::tempdir().unwrap();
        for (filename, observation) in [
            (
                format!("terminal-opencode-adoption__{}.json", expected.launch_nonce),
                current,
            ),
            (
                format!("terminal-opencode-adoption__{}.json", stale.launch_nonce),
                stale,
            ),
        ] {
            std::fs::write(
                root.path().join(filename),
                serde_json::to_vec(&serde_json::json!({
                    "session_id": observation.root_session_id.clone(),
                    "adoption_observation": observation,
                }))
                .unwrap(),
            )
            .unwrap();
        }
        assert_eq!(
            process_opencode_adoption_signals(
                root.path(),
                "terminal-opencode-adoption",
                &gate,
                &native_session_id,
            ),
            1
        );
        assert_eq!(
            native_session_id.lock().unwrap().as_deref(),
            Some("ses_exactroot")
        );
        assert_eq!(
            gate.lock().unwrap().observation.as_ref().unwrap(),
            &observation(&expected)
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod codex_identity_tests {
    use super::validate_codex_candidate;

    #[test]
    fn exact_non_ephemeral_codex_identity_is_required() {
        assert!(validate_codex_candidate(Some("thread-a"), None, "thread-a", false).is_ok());
        assert!(validate_codex_candidate(Some("thread-a"), None, "thread-b", false).is_err());
        assert!(validate_codex_candidate(None, None, "thread-a", true).is_err());
        assert!(validate_codex_candidate(None, Some("thread-a"), "thread-b", false).is_err());
    }
}

#[cfg(all(test, target_os = "linux"))]
mod provider_exec_tests {
    use super::*;

    #[tokio::test]
    async fn provider_exec_profile_rejects_combined_final_environment_before_pty_dispatch() {
        let owned = tempfile::tempdir().unwrap();
        let launch: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"exec-profile","streamId":"exec-profile-stream","mode":"codex",
            "program":"/usr/bin/true","cwd":owned.path(),"workspacePath":owned.path(),
            "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,"projectKey":"exec-profile",
            "env":{"PATH":"/usr/bin:/bin"}
        }))
        .unwrap();
        let environment = (0..17)
            .map(|i| (format!("FRESHELL_EXEC_FIXTURE_{i}"), "x".repeat(64 * 1024)))
            .collect();
        let mut result = HostedPty::spawn(
            owned.path(),
            IncarnationId::new(),
            &launch,
            environment,
            None,
            None,
            None,
        )
        .await;
        // This regression owns and stops only the unexpectedly dispatched
        // synthetic PTY, inside the required lifecycle sandbox.
        if let Ok(pty) = &mut result {
            pty.stop().await;
        }
        assert!(
            matches!(result,Err(ref cause) if cause.contains("provider exec profile")),
            "oversized final argv+env must fail with a classified pre-dispatch profile error"
        );
    }
}
