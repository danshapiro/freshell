use super::cli;
use freshell_agent_runtime::ProviderStoreProbe;
use freshell_codex::{
    launch_lifecycle::{CodexLaunchSidecar, CodexTerminalLaunchManager, LaunchClass},
    launch_plan::{codex_remote_args, CodexLaunchPlanInput, CODEX_INITIAL_LAUNCH_ATTEMPTS},
    remote_proxy::RemoteProxyEvent,
};
use freshell_runtime_protocol::{ResumeSpec, TerminalLaunchSpec};
use std::sync::Arc;
use tokio::sync::mpsc;

pub struct PreparedCodexLaunch {
    pub sidecar: Arc<CodexLaunchSidecar>,
    pub events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    pub remote_args: [String; 4],
}

pub async fn prepare(terminal: &TerminalLaunchSpec) -> Result<PreparedCodexLaunch, String> {
    if terminal.mode != "codex" {
        return Err("Codex launch adapter received another provider".into());
    }
    let input = CodexLaunchPlanInput {
        cwd: Some(&terminal.cwd),
        resume_session_id: terminal.resume_session_id.as_deref(),
        model: terminal.provider_model.as_deref(),
        sandbox: terminal.provider_sandbox.as_deref(),
        approval_policy: terminal.provider_permission_mode.as_deref(),
    };
    let launch = CodexTerminalLaunchManager::global()
        .plan_create_with_retry_uncancellable(
            &input,
            CODEX_INITIAL_LAUNCH_ATTEMPTS,
            LaunchClass::Interactive,
        )
        .await
        .map_err(|error| error.to_string())?;
    let remote_args = codex_remote_args(&launch.remote_ws_url)
        .map_err(|error| format!("invalid Codex proxy URL: {error:?}"))?;
    Ok(PreparedCodexLaunch {
        sidecar: launch.sidecar,
        events: launch.events,
        remote_args,
    })
}

pub async fn probe(
    spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    if spec.provider_session.provider != "codex" {
        return Err("Codex recovery adapter received another provider".into());
    }
    cli::probe_as_provider(spec, run_as_uid, run_as_gid).await
}
