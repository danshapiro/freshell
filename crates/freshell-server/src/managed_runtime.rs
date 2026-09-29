#![cfg(feature = "managed-runtime-v1")]

use freshell_runtime_client::{ClientError, RuntimeClient};
use freshell_runtime_protocol::{
    DesiredState, LaunchRequest, LaunchState, RecoveryBlockReason, RecoveryOutcome, RecoveryProbe,
    RecoveryResult, RecoveryTrigger, RequestId, RuntimeErrorCode, RuntimeLimits, RuntimeProfile,
    RuntimeView, SoulId, StopOutcome, TerminalLaunchSpec, ViewIntentKind, ViewIntentRequest,
    ViewVisibilityIntent,
};
use freshell_terminal::registry::{
    ManagedOutputChunk, ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor,
    ManagedTerminalFuture, ManagedTerminalLaunch,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tokio::sync::Mutex;

#[path = "managed_output_validation.rs"]
mod managed_output_validation;

#[derive(Default)]
struct ManagedRecoveryState {
    in_flight: Mutex<HashSet<String>>,
    blocked: Mutex<HashMap<String, String>>,
}

#[derive(Clone)]
pub struct ServerManagedRuntimeController {
    client: RuntimeClient,
    recovery: Arc<ManagedRecoveryState>,
}

impl ServerManagedRuntimeController {
    pub async fn from_env() -> Result<Option<Arc<Self>>, String> {
        if std::env::var("FRESHELL_MANAGED_RUNTIME_V1").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        freshell_agent_runtime::process_qualification_policy()?;
        let socket = std::env::var("FRESHELL_RUNTIME_CONTROL_SOCKET").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SOCKET".to_string()
        })?;
        let secret = std::env::var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SECRET_FILE"
                .to_string()
        })?;
        let client = RuntimeClient::from_secret_file(socket, secret)
            .await
            .map_err(|e| format!("managed runtime client: {e}"))?;
        client
            .health()
            .await
            .map_err(|e| format!("managed runtime supervisor health: {e}"))?;
        let controller = Arc::new(Self {
            client,
            recovery: Arc::new(ManagedRecoveryState::default()),
        });
        Ok(Some(controller))
    }

    pub fn runtime_client(&self) -> RuntimeClient {
        self.client.clone()
    }

    async fn recovery_in_flight(&self, soul_id: &str) -> bool {
        self.recovery.in_flight.lock().await.contains(soul_id)
    }

    async fn blocked_recovery(&self, soul_id: &str) -> Option<String> {
        self.recovery.blocked.lock().await.get(soul_id).cloned()
    }

    async fn schedule_recovery(&self, soul: SoulId, trigger: RecoveryTrigger) {
        let key = soul.to_string();
        {
            let mut in_flight = self.recovery.in_flight.lock().await;
            if !in_flight.insert(key.clone()) {
                return;
            }
        }
        self.recovery.blocked.lock().await.remove(&key);
        let client = self.client.clone();
        let state = Arc::clone(&self.recovery);
        tokio::spawn(async move {
            if let Some(delay) = managed_recovery_test_delay() {
                tokio::time::sleep(delay).await;
            }
            let result = recover_with_policy(&client, soul, trigger).await;
            match result {
                Ok(result)
                    if matches!(
                        result.outcome,
                        RecoveryOutcome::Replaced
                            | RecoveryOutcome::Reattached
                            | RecoveryOutcome::AlreadyLive
                    ) =>
                {
                    state.blocked.lock().await.remove(&key);
                }
                Ok(result) => {
                    state.blocked.lock().await.insert(
                        key.clone(),
                        format!(
                            "managed soul recovery ended in {:?}: {}",
                            result.outcome,
                            recovery_probe_summary(result.probe.as_ref())
                        ),
                    );
                }
                Err(error) => {
                    state.blocked.lock().await.insert(key.clone(), error);
                }
            }
            state.in_flight.lock().await.remove(&key);
        });
    }
}

impl ManagedTerminalController for ServerManagedRuntimeController {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        create_request_id: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async move {
            let views = self
                .client
                .inventory()
                .await
                .map_err(|error| error.to_string())?;
            let Some(view) = views.iter().rev().find(|view| {
                view.terminal_id.as_deref() == Some(terminal_id)
                    && view.desired_state == DesiredState::Running
                    && !matches!(
                        view.launch_state,
                        LaunchState::Stopped | LaunchState::Failed
                    )
            }) else {
                return Ok(None);
            };
            managed_descriptor_from_view(view, create_request_id).map(Some)
        })
    }

    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        Box::pin(async move {
            let create_key = request
                .create_request_id
                .as_deref()
                .unwrap_or(&request.terminal_id);
            let soul_id = stable_soul_id(create_key)?;
            let cwd = canonical_cwd(request.spec.cwd.as_deref())?;
            let workspace = workspace_root(&cwd);
            let (run_as_uid, run_as_gid) = (MANAGED_PROVIDER_UID, MANAGED_PROVIDER_GID);
            let git_common_dir = git_common_dir(&workspace);
            let project_key = stable_project_key(&workspace);
            let inventory = self.client.inventory().await.map_err(|e| e.to_string())?;
            if let Some(descriptor) = reused_running_descriptor(
                &inventory,
                &soul_id,
                &request.terminal_id,
                request.create_request_id.clone(),
            )? {
                return Ok(descriptor);
            }
            // Phase 2 persists the launch spec in the supervisor registry.
            // Persist ONLY an explicit non-secret allowlist — never the web
            // server's resolved child environment wholesale (which can carry
            // AUTH_TOKEN, provider API keys, cloud credentials, proxy creds, ...).
            let env = managed_provider_env(&request.mode, &request.env);
            let provider_secret_references = {
                crate::managed_provider_bootstrap::named_provider_onecli_references(&request.mode)?
            };
            let args = managed_provider_args(&request.mode, request.spec.args)?;
            let request_id = stable_request_id(create_key)?;
            let opencode_input = if request.mode == "opencode" {
                crate::managed_mcp_capability::OpencodeEphemeralInput {
                    inline_config: request
                        .env
                        .get("OPENCODE_CONFIG_CONTENT")
                        .map(String::as_str),
                    tui_config_path: request.env.get("OPENCODE_TUI_CONFIG").map(String::as_str),
                }
            } else {
                Default::default()
            };
            let mcp_capability = matches!(
                request.mode.as_str(),
                "claude" | "codex" | "opencode" | "amplifier"
            )
            .then(|| {
                crate::managed_mcp_capability::issue_mcp_capability(
                    &soul_id,
                    &request.mode,
                    opencode_input,
                )
            })
            .transpose()?;
            let mut provider_launch_context =
                crate::managed_provider_bootstrap::provider_launch_context_for_managed(
                    &request.mode,
                    &workspace,
                    mcp_capability.clone(),
                );
            if let Some(context) = provider_launch_context.as_mut() {
                if let freshell_runtime_protocol::ProviderPreparation::Opencode {
                    inline_config,
                    tui_config,
                    ..
                } = &mut context.preparation
                {
                    *inline_config = opencode_input.inline_config.is_some();
                    if opencode_input.tui_config_path.is_some() {
                        let jsonc = opencode_input
                            .tui_config_path
                            .is_some_and(|path| path.to_ascii_lowercase().ends_with(".jsonc"));
                        *tui_config = Some(freshell_runtime_protocol::ProviderConfigReference {
                            root: freshell_runtime_protocol::ProviderConfigRoot::Ephemeral,
                            relative_path: if jsonc {
                                "tui-config.jsonc"
                            } else {
                                "tui-config.json"
                            }
                            .into(),
                            provider_relative_path: if jsonc {
                                ".freshell/opencode/user-tui.jsonc"
                            } else {
                                ".freshell/opencode/user-tui.json"
                            }
                            .into(),
                            format: if jsonc { "jsonc" } else { "json" }.into(),
                        });
                    }
                }
            }
            if mcp_capability.is_some() && provider_launch_context.is_none() {
                if let Some(capability) = &mcp_capability {
                    let _ =
                        crate::managed_mcp_capability::revoke_mcp_capability(&capability.grant_id);
                }
                return Err("managed provider preparation unavailable".into());
            }
            let launch = LaunchRequest {
                soul_id: soul_id.clone(),
                provider: request.mode.clone(),
                provider_store_id: soul_id.to_string(),
                creation_seed_ref: create_key.to_string(),
                limits: RuntimeLimits {
                    cpu_milli: 2000,
                    memory_bytes: 4 * 1024 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 512,
                },
                profile: RuntimeProfile::DefaultAgent,
                project_key: project_key.clone(),
                native_session_id: request.resume_session_id.clone(),
                fixture: None,
                fresh_agent: None,
                terminal: Some(TerminalLaunchSpec {
                    terminal_id: request.terminal_id.clone(),
                    stream_id: request.stream_id.clone(),
                    mode: request.mode.clone(),
                    program: request.spec.program,
                    args,
                    env,
                    cwd: cwd.to_string_lossy().into_owned(),
                    run_as_uid,
                    run_as_gid,
                    cols: request.spec.cols,
                    rows: request.spec.rows,
                    project_key: project_key.clone(),
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    git_common_dir: git_common_dir.map(|p| p.to_string_lossy().into_owned()),
                    create_request_id: request.create_request_id.clone(),
                    resume_session_id: request.resume_session_id.clone(),
                    provider_model: request.provider_model.clone(),
                    provider_reasoning_effort: request.provider_reasoning_effort.clone(),
                    provider_sandbox: request.provider_sandbox.clone(),
                    provider_permission_mode: request.provider_permission_mode.clone(),
                    provider_bootstrap_files: Vec::new(),
                    provider_secret_references,
                    provider_launch_context,
                }),
                view_intent: Some(ViewIntentRequest {
                    owner_id: String::new(),
                    workspace_id: project_key.clone(),
                    kind: ViewIntentKind::AutomaticPrimary,
                    preferred_tab_id: request.view_tab_id.clone(),
                    preferred_pane_id: request.view_pane_id.clone(),
                    title: Some(format!("{} agent", provider_label(&request.mode))),
                    placement_group: None,
                    visibility: ViewVisibilityIntent::Visible,
                }),
                expected_control_epoch: None,
            };
            let result = match self.client.launch(request_id, launch).await {
                Ok(result) => result,
                Err(error) => {
                    if let Some(capability) = &mcp_capability {
                        let _ = crate::managed_mcp_capability::revoke_mcp_capability(
                            &capability.grant_id,
                        );
                    }
                    return Err(error.to_string());
                }
            };
            Ok(ManagedTerminalDescriptor {
                soul_id: result.view.soul_id.to_string(),
                incarnation_id: result.view.incarnation_id.to_string(),
                terminal_id: request.terminal_id,
                stream_id: request.stream_id,
                mode: request.mode,
                cwd: cwd.to_string_lossy().into_owned(),
                resume_session_id: request.resume_session_id,
                create_request_id: request.create_request_id,
            })
        })
    }

    fn input<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id;
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            if self.recovery_in_flight(&soul_key).await {
                return Err(
                    "managed soul recovery is in progress; input was not dispatched".into(),
                );
            }
            if self.blocked_recovery(&soul_key).await.is_some() {
                // New user input is an explicit retry/repair signal. Re-arm the
                // persisted flap ceiling and prove continuity before accepting
                // any bytes; never substitute a fresh provider session.
                let recovered = self
                    .client
                    .recover(soul.clone(), RecoveryTrigger::ManualRetry)
                    .await
                    .map_err(|error| error.to_string())?;
                match recovered.outcome {
                    RecoveryOutcome::Reattached
                    | RecoveryOutcome::Replaced
                    | RecoveryOutcome::AlreadyLive => {
                        self.recovery.blocked.lock().await.remove(&soul_key);
                    }
                    _ => {
                        let message = format!(
                            "managed soul recovery ended in {:?}: {}",
                            recovered.outcome,
                            recovery_probe_summary(recovered.probe.as_ref())
                        );
                        self.recovery
                            .blocked
                            .lock()
                            .await
                            .insert(soul_key, message.clone());
                        return Err(message);
                    }
                }
            }
            self.client
                .input(RequestId::new(), soul, data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn resize<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        cols: u16,
        rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            self.client
                .resize(soul, cols, rows)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id;
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            match self
                .client
                .stop(soul.clone())
                .await
                .map_err(|e| e.to_string())?
            {
                StopOutcome::VerifiedEmpty => {
                    crate::managed_mcp_capability::revoke_soul_capabilities(&soul)?;
                    self.recovery.in_flight.lock().await.remove(&soul_key);
                    self.recovery.blocked.lock().await.remove(&soul_key);
                    Ok(())
                }
                other => Err(format!(
                    "managed runtime stop not verified empty: {other:?}"
                )),
            }
        })
    }

    fn read_output<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        after_seq: i64,
        max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async move {
            let soul_key = terminal.soul_id.clone();
            let soul = SoulId::parse(&soul_key).map_err(|e| e.to_string())?;
            if let Some(error) = self.blocked_recovery(&soul_key).await {
                return Err(error);
            }
            if self.recovery_in_flight(&soul_key).await {
                return Ok(ManagedOutputRead {
                    stream_epoch: None,
                    incarnation_id: None,
                    reset_required: false,
                    truncated: false,
                    retained_from_seq: after_seq,
                    head_seq: after_seq,
                    exit_code: None,
                    native_session_id: terminal.resume_session_id,
                    chunks: Vec::new(),
                });
            }
            let output = match self
                .client
                .read_output_for_epoch(
                    soul.clone(),
                    after_seq.max(0) as u64,
                    max_bytes,
                    Some(terminal.stream_id.clone()),
                )
                .await
            {
                Ok(output) => output,
                Err(error) if recoverable_host_error(&error) => {
                    self.schedule_recovery(soul, RecoveryTrigger::HostUnreachable)
                        .await;
                    return Ok(ManagedOutputRead {
                        stream_epoch: None,
                        incarnation_id: None,
                        reset_required: false,
                        truncated: false,
                        retained_from_seq: after_seq,
                        head_seq: after_seq,
                        exit_code: None,
                        native_session_id: terminal.resume_session_id,
                        chunks: Vec::new(),
                    });
                }
                Err(error) => return Err(error.to_string()),
            };
            managed_output_validation::validate(&output, &terminal.terminal_id)?;
            if output.exited {
                // Never hold the WS poll's 500ms timeout across stop/start or
                // retry backoff. A single per-soul background task owns the
                // 2s/10s retry policy and leaves the pane attached meanwhile.
                self.schedule_recovery(soul, RecoveryTrigger::ProviderExit)
                    .await;
            }
            Ok(ManagedOutputRead {
                stream_epoch: Some(output.stream_epoch.clone()),
                incarnation_id: Some(output.incarnation_id.to_string()),
                // Replacement starts a new durable output epoch. Force the
                // consumer to reset its cursor instead of interpreting the new
                // incarnation as a gap in the old stream.
                reset_required: output.reset_required || output.stream_epoch != terminal.stream_id,
                truncated: output.truncated,
                retained_from_seq: output.retained_from_seq.min(i64::MAX as u64) as i64,
                head_seq: output.head_seq.min(i64::MAX as u64) as i64,
                // Provider exit is observed state, not user stop. Keep the pane
                // alive while the recovery task runs or reports BLOCKED.
                exit_code: if output.exited {
                    None
                } else {
                    output.exit_code
                },
                native_session_id: output.native_session_id,
                chunks: output
                    .frames
                    .into_iter()
                    .map(|frame| ManagedOutputChunk {
                        seq_start: frame.seq_start.min(i64::MAX as u64) as i64,
                        seq_end: frame.seq_end.min(i64::MAX as u64) as i64,
                        data: frame.data,
                    })
                    .collect(),
            })
        })
    }
}

fn managed_recovery_test_delay() -> Option<std::time::Duration> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("FRESHELL_MANAGED_RECOVERY_TEST_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|delay| *delay > 0 && *delay <= 10_000)
        .map(std::time::Duration::from_millis)
}

fn recoverable_host_error(error: &ClientError) -> bool {
    matches!(
        error.runtime_code(),
        Some(
            RuntimeErrorCode::HostUnreachable
                | RuntimeErrorCode::HostAuthenticationFailed
                | RuntimeErrorCode::BackendUnavailable
        )
    )
}

const AUTOMATIC_RECOVERY_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(10),
];

async fn recover_with_policy(
    client: &RuntimeClient,
    soul: SoulId,
    trigger: RecoveryTrigger,
) -> Result<RecoveryResult, String> {
    let mut last_result = None;
    let mut last_error = None;
    for attempt in 0..=AUTOMATIC_RECOVERY_RETRY_DELAYS.len() {
        if attempt > 0 {
            tokio::time::sleep(AUTOMATIC_RECOVERY_RETRY_DELAYS[attempt - 1]).await;
        }
        match client.recover(soul.clone(), trigger).await {
            Ok(result) => {
                if !automatic_retryable(&result) {
                    return Ok(result);
                }
                last_result = Some(result);
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    if last_result.is_some() {
        return client
            .recover(soul, RecoveryTrigger::RetryExhausted)
            .await
            .map_err(|error| error.to_string());
    }
    Err(last_error.unwrap_or_else(|| "managed recovery exhausted without a verdict".into()))
}

fn automatic_retryable(result: &RecoveryResult) -> bool {
    if result.outcome != RecoveryOutcome::Blocked {
        return false;
    }
    matches!(
        result.probe.as_ref(),
        Some(RecoveryProbe::Blocked {
            reason: RecoveryBlockReason::RateLimited
                | RecoveryBlockReason::CapabilityPending
                | RecoveryBlockReason::ProviderUnavailable
                | RecoveryBlockReason::StoreUnreadable
                | RecoveryBlockReason::WorkspaceUnavailable
                | RecoveryBlockReason::InsufficientResources
                | RecoveryBlockReason::OldRuntimeNotEmpty,
            ..
        })
    )
}

fn recovery_probe_summary(probe: Option<&RecoveryProbe>) -> String {
    match probe {
        Some(RecoveryProbe::Blocked {
            reason, retry_hint, ..
        }) => retry_hint
            .repair
            .clone()
            .unwrap_or_else(|| format!("{reason:?}")),
        Some(RecoveryProbe::DefinitivelyUnavailable { reason, .. }) => reason.clone(),
        Some(RecoveryProbe::PristineSeedReady { .. }) => "pristine seed ready".into(),
        Some(RecoveryProbe::ResumeReady { .. }) => "native resume ready".into(),
        Some(RecoveryProbe::ReattachReady { .. }) => "reattach ready".into(),
        None => "no recovery probe was returned".into(),
    }
}

fn managed_descriptor_from_view(
    view: &RuntimeView,
    reconcile_create_request_id: Option<String>,
) -> Result<ManagedTerminalDescriptor, String> {
    let terminal_id = view
        .terminal_id
        .clone()
        .ok_or_else(|| "managed runtime view has no terminal id".to_string())?;
    let stream_id = view
        .terminal_stream_id
        .clone()
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable stream id"))?;
    let mode = view
        .terminal_mode
        .clone()
        .or_else(|| view.provider.clone())
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable mode"))?;
    let cwd = view
        .terminal_cwd
        .clone()
        .ok_or_else(|| format!("managed terminal {terminal_id} has no durable cwd"))?;
    Ok(ManagedTerminalDescriptor {
        soul_id: view.soul_id.to_string(),
        incarnation_id: view.incarnation_id.to_string(),
        terminal_id,
        stream_id,
        mode,
        cwd,
        resume_session_id: view
            .native_session_id
            .clone()
            .or_else(|| view.terminal_resume_session_id.clone()),
        create_request_id: reconcile_create_request_id
            .or_else(|| view.terminal_create_request_id.clone()),
    })
}

fn reusable_running_view(
    views: &[RuntimeView],
    soul_id: &SoulId,
    terminal_id: &str,
) -> Result<Option<RuntimeView>, String> {
    let matching: Vec<&RuntimeView> = views
        .iter()
        .filter(|view| &view.soul_id == soul_id)
        .collect();
    if matching.is_empty() {
        return Ok(None);
    }
    let running: Vec<&RuntimeView> = matching
        .iter()
        .copied()
        .filter(|view| view.launch_state == LaunchState::Running)
        .collect();
    if running.len() != 1 {
        return Err(format!(
            "managed soul {} exists but has {} running incarnations; refusing a replacement launch",
            soul_id.as_str(),
            running.len()
        ));
    }
    let view = running[0];
    if view.terminal_id.as_deref() != Some(terminal_id) {
        return Err(format!(
            "managed soul {} is already bound to terminal {:?}, not {terminal_id}",
            soul_id.as_str(),
            view.terminal_id
        ));
    }
    Ok(Some(view.clone()))
}

/// Reconstruct a retry result exclusively from the already-committed runtime
/// view. A web crash after launch but before acknowledgment can retry with a
/// newly assembled request whose stream/native identity is stale or absent;
/// only the durable view identifies the one existing writer.
fn reused_running_descriptor(
    views: &[RuntimeView],
    soul_id: &SoulId,
    terminal_id: &str,
    reconcile_create_request_id: Option<String>,
) -> Result<Option<ManagedTerminalDescriptor>, String> {
    reusable_running_view(views, soul_id, terminal_id)?
        .as_ref()
        .map(|view| managed_descriptor_from_view(view, reconcile_create_request_id))
        .transpose()
}

fn managed_env_allowlist(
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "SHELL",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "FRESHELL",
        "FRESHELL_TERMINAL_ID",
        "FRESHELL_TAB_ID",
        "FRESHELL_PANE_ID",
        "PROMPT_TOOLKIT_NO_CPR",
    ];
    source
        .iter()
        .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn managed_provider_env(
    mode: &str,
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = managed_env_allowlist(source);
    // Never persist the web host's PATH into a pinned workload image. It may
    // contain host-only homes, version-manager shims, or credential helpers.
    env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
    // Provider state belongs to this soul's Docker volume, not the web
    // server's inherited HOME. These paths are inside the workload.
    env.insert("HOME".into(), "/home/freshell/provider".into());
    env.insert(
        "CLAUDE_HOME".into(),
        "/home/freshell/provider/.claude".into(),
    );
    env.insert(
        "CLAUDE_CONFIG_DIR".into(),
        "/home/freshell/provider/.claude".into(),
    );
    env.insert("CODEX_HOME".into(), "/home/freshell/provider/.codex".into());
    env.insert(
        "XDG_DATA_HOME".into(),
        "/home/freshell/provider/.local/share".into(),
    );
    env.insert(
        "XDG_CONFIG_HOME".into(),
        "/home/freshell/provider/.config".into(),
    );
    env.insert(
        "AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    env.insert(
        "FRESHELL_AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    if mode == "opencode" {
        env.insert("TMPDIR".into(), "/run/opencode-tmp".into());
        if let Some(value) = source
            .get("FRESHELL_OPENCODE_REBIND")
            .filter(|value| matches!(value.as_str(), "0" | "false"))
        {
            env.insert("FRESHELL_OPENCODE_REBIND".into(), value.clone());
        }
        // Arbitrary inline JSON can carry credentials in values such as MCP
        // command arguments. It is staged beside the private incarnation grant,
        // never serialized into the supervisor's durable launch environment.
        if let Some(permission) = source
            .get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
            .map(String::as_str)
            .filter(|value| matches!(*value, "ask" | "allow" | "deny"))
        {
            env.insert(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                permission.into(),
            );
        }
    }
    env
}

fn managed_provider_args(mode: &str, args: Vec<String>) -> Result<Vec<String>, String> {
    let settings = (mode == "claude").then(|| {
        freshell_platform::cli_launch::claude_settings_json(
            freshell_platform::cli_launch::ProviderTarget::Unix,
        )
    });
    freshell_runtime_protocol::durable_managed_terminal_args(mode, args, settings.as_deref())
        .map_err(|error| error.message)
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "amplifier" => "Amplifier",
        "shell" => "Shell",
        other => other,
    }
}

fn stable_soul_id(key: &str) -> Result<SoulId, String> {
    SoulId::parse(format!("soul-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_request_id(key: &str) -> Result<RequestId, String> {
    RequestId::parse(format!("request-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_project_key(path: &Path) -> String {
    format!("project-{}", stable_hex(&path.to_string_lossy()))
}
fn stable_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..32].to_string()
}

const MANAGED_PROVIDER_UID: u32 = 65_534;
const MANAGED_PROVIDER_GID: u32 = 0;

fn canonical_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = cwd
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    let path =
        std::fs::canonicalize(&path).map_err(|e| format!("managed cwd {}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!(
            "managed cwd is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn workspace_root(cwd: &Path) -> PathBuf {
    git_stdout(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|raw| std::fs::canonicalize(raw.trim()).ok())
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let raw = git_stdout(workspace, &["rev-parse", "--git-common-dir"])?;
    let raw = PathBuf::from(raw.trim());
    let candidate = if raw.is_absolute() {
        raw
    } else {
        workspace.join(raw)
    };
    std::fs::canonicalize(candidate).ok().filter(|p| p.is_dir())
}

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_env_drops_server_and_provider_secrets() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("TERM", "xterm-256color"),
            ("FRESHELL_TERMINAL_ID", "t1"),
            ("FRESHELL_TOKEN", "web-secret"),
            ("AUTH_TOKEN", "web-secret-2"),
            ("ANTHROPIC_API_KEY", "provider-secret"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "provider-oauth"),
            ("AWS_SECRET_ACCESS_KEY", "cloud-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let filtered = managed_env_allowlist(&source);
        assert_eq!(
            filtered.get("PATH").map(String::as_str),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(
            filtered.get("FRESHELL_TERMINAL_ID").map(String::as_str),
            Some("t1")
        );
        for key in [
            "FRESHELL_TOKEN",
            "AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!filtered.contains_key(key), "secret key leaked: {key}");
        }
    }

    #[test]
    fn running_soul_is_reused_before_launch_payload_rehash_and_mismatches_fail_closed() {
        let soul = SoulId::parse("soul-terminal-test").unwrap();
        let running = freshell_runtime_protocol::RuntimeView {
            soul_id: soul.clone(),
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            launch_state: freshell_runtime_protocol::LaunchState::Running,
            cleanup_state: freshell_runtime_protocol::CleanupState::None,
            intent_revision: 1,
            container_id: Some("a".repeat(64)),
            host_boot_id: Some(freshell_runtime_protocol::HostBootId::new()),
            execution_generation: 1,
            effective_limits: None,
            configured_limits: None,
            view_intent_revision: None,
            terminal_id: Some("terminal-stable".into()),
            terminal_stream_id: Some("stream-stable".into()),
            terminal_mode: Some("opencode".into()),
            terminal_cwd: Some("/workspace".into()),
            terminal_create_request_id: Some("create-stable".into()),
            terminal_resume_session_id: Some("request-time-session".into()),
            fresh_agent_session_id: None,
            fresh_agent_session_type: None,
            fresh_agent_runtime_variant: None,
            project_key: Some("project-test".into()),
            profile: Some(RuntimeProfile::DefaultAgent),
            desired_state: freshell_runtime_protocol::DesiredState::Running,
            recovery_state: freshell_runtime_protocol::RecoveryState::Live,
            durability_state: freshell_runtime_protocol::DurabilityState::Unknown,
            allocation_state: freshell_runtime_protocol::AllocationState::Allocated,
            provider: Some("opencode".into()),
            native_session_id: Some("provider-materialized-session".into()),
            recovery_reason: None,
            incident_id: None,
            prior_incarnation_id: None,
            recovery_attempt_id: None,
            evidence_revision: 0,
            successful_recoveries_in_window: 0,
        };
        let descriptor = managed_descriptor_from_view(&running, Some("reconcile-create".into()))
            .expect("durable managed descriptor");
        assert_eq!(descriptor.terminal_id, "terminal-stable");
        assert_eq!(descriptor.stream_id, "stream-stable");
        assert_eq!(
            descriptor.create_request_id.as_deref(),
            Some("reconcile-create")
        );
        let reused =
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-stable")
                .unwrap()
                .expect("running soul should be reused");
        assert_eq!(reused.incarnation_id, running.incarnation_id);

        let descriptor = reused_running_descriptor(
            std::slice::from_ref(&running),
            &soul,
            "terminal-stable",
            Some("retry-after-web-crash".into()),
        )
        .unwrap()
        .expect("launch-before-ack retry reuses the existing writer");
        assert_eq!(
            descriptor.incarnation_id,
            running.incarnation_id.to_string()
        );
        assert_eq!(descriptor.stream_id, "stream-stable");
        assert_eq!(
            descriptor.resume_session_id.as_deref(),
            Some("provider-materialized-session")
        );
        assert_eq!(
            descriptor.create_request_id.as_deref(),
            Some("retry-after-web-crash")
        );

        assert!(
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-other").is_err()
        );
        let mut stopped = running;
        stopped.launch_state = freshell_runtime_protocol::LaunchState::Stopped;
        assert!(reusable_running_view(&[stopped], &soul, "terminal-stable").is_err());
    }

    #[test]
    fn managed_opencode_env_uses_soul_state_and_drops_host_config_paths() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("OPENCODE_CONFIG_CONTENT", r#"{"secret":"do-not-persist"}"#),
            (
                "OPENCODE_TUI_CONFIG",
                "/home/user/.freshell/opencode/tui.json",
            ),
            ("OPENCODE_API_KEY", "provider-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let env = managed_provider_env("opencode", &source);
        assert_eq!(
            env.get("HOME").map(String::as_str),
            Some("/home/freshell/provider")
        );
        assert_eq!(
            env.get("XDG_DATA_HOME").map(String::as_str),
            Some("/home/freshell/provider/.local/share")
        );
        assert_eq!(
            env.get("XDG_CONFIG_HOME").map(String::as_str),
            Some("/home/freshell/provider/.config")
        );
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some("/run/opencode-tmp")
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(!env.contains_key("OPENCODE_API_KEY"));
        assert!(!env.values().any(|value| value.contains("do-not-persist")));
    }

    #[test]
    fn managed_opencode_inline_plugin_configuration_is_child_only() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"plugin":["file:///workspace/plugin.ts"],"snapshot":true,"maxTokens":8192}"#
                    .into(),
            ),
            ("FRESHELL_OPENCODE_REBIND".into(), "0".into()),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_OPENCODE_REBIND").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn managed_opencode_does_not_filter_inline_json_by_field_name() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"plugin":["file:///workspace/plugin.ts"],"provider":{"apiKey":"raw-secret","model":"ordinary-model"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("raw-secret")));
    }

    #[test]
    fn managed_opencode_never_persists_nested_inline_secret_values() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"mcp":{"vendor":{"type":"local","command":["tool","--token","nested-secret-byte"]}},"provider":{"endpoint":"https://nested-secret-byte.example"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        let serialized = serde_json::to_string(&env).unwrap();
        assert!(!serialized.contains("nested-secret-byte"));
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
    }

    #[test]
    fn managed_opencode_permission_policy_is_sanitized_and_persistable() {
        for allowed in ["ask", "allow", "deny"] {
            let source = std::collections::BTreeMap::from([(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
                allowed.to_string(),
            )]);
            let env = managed_provider_env("opencode", &source);
            assert_eq!(
                env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                    .map(String::as_str),
                Some(allowed)
            );
        }

        let source = std::collections::BTreeMap::from([(
            "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
            "ask-with-secret-text".to_string(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("secret-text")));
    }

    #[test]
    fn managed_opencode_bash_policy_preserves_other_ordinary_permissions() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"permission":{"read":"allow"}}"#.into(),
            ),
            (
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                "ask".into(),
            ),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                .map(String::as_str),
            Some("ask")
        );
    }

    #[test]
    fn managed_claude_strips_web_bound_mcp_tempfile_only() {
        let args = vec![
            "--settings".into(),
            "{}".into(),
            "--mcp-config".into(),
            "/tmp/freshell-mcp/t1.json".into(),
            "--session-id".into(),
            "s1".into(),
        ];
        assert_eq!(
            managed_provider_args("claude", args).unwrap(),
            vec![
                "--settings".to_string(),
                freshell_platform::cli_launch::claude_settings_json(
                    freshell_platform::cli_launch::ProviderTarget::Unix,
                ),
                "--session-id".to_string(),
                "s1".to_string(),
            ]
        );
    }

    #[test]
    fn managed_terminal_argument_path_rejects_credential_flags_before_persistence() {
        for mode in ["claude", "codex", "opencode", "amplifier"] {
            for arguments in [
                vec!["--api-key", "fixture-secret-bytes"],
                vec!["--api-key=fixture-secret-bytes"],
            ] {
                assert!(
                    managed_provider_args(
                        mode,
                        arguments.into_iter().map(str::to_string).collect()
                    )
                    .is_err(),
                    "{mode}"
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "managed_output_rpc_tests.rs"]
mod managed_output_rpc_tests;
