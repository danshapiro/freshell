use super::cli;
use freshell_agent_runtime::ProviderStoreProbe;
use freshell_codex::{
    launch_lifecycle::{CodexLaunchSidecar, CodexTerminalLaunchManager, LaunchClass},
    launch_plan::{
        codex_remote_args, CodexLaunchPlanInput, CodexSidecarLaunchContext,
        CODEX_INITIAL_LAUNCH_ATTEMPTS,
    },
    remote_proxy::RemoteProxyEvent,
};
use freshell_runtime_protocol::{ResumeSpec, TerminalLaunchSpec};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Inspect the native recorder under its owner, without starting or resuming
/// Codex and without giving the host access to the private provider HOME.
pub async fn naming_rollout(
    home: String,
    thread_id: String,
    uid: u32,
    gid: u32,
) -> Result<Option<std::path::PathBuf>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = cli::provider_command(std::path::Path::new("/usr/bin/timeout"), uid, gid)
        .args(["--kill-after=1s", "5s"])
        .arg(executable)
        .args([
            "codex-naming-proof",
            "--codex-home",
            &home,
            "--thread-id",
            &thread_id,
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|error| format!("run Codex naming proof: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Codex naming proof exited {:?}",
            output.status.code()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode Codex naming proof: {error}"))
}

pub fn run_naming_proof(args: &[String]) -> Result<(), String> {
    let argument = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].as_str())
            .ok_or_else(|| format!("missing {key}"))
    };
    let rollout = freshell_codex::durability::locate_thread_rollout_in_home(
        std::path::Path::new(argument("--codex-home")?),
        argument("--thread-id")?,
    );
    serde_json::to_writer(std::io::stdout(), &rollout)
        .map_err(|error| format!("encode Codex naming proof: {error}"))
}

pub struct PreparedCodexLaunch {
    pub sidecar: Arc<CodexLaunchSidecar>,
    pub events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    pub remote_args: [String; 4],
}

pub async fn prepare(
    terminal: &TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
) -> Result<PreparedCodexLaunch, String> {
    if terminal.mode != "codex" {
        return Err("Codex launch adapter received another provider".into());
    }
    let input = CodexLaunchPlanInput {
        cwd: Some(&terminal.cwd),
        resume_session_id: terminal.resume_session_id.as_deref(),
        model: terminal.provider_model.as_deref(),
        sandbox: terminal.provider_sandbox.as_deref(),
        approval_policy: terminal.provider_permission_mode.as_deref(),
        // The managed session host owns the sidecar inside the soul enclosure.
        // It has no web-owned MCP context to inherit, so use the explicit
        // empty launch context rather than silently reintroducing web state.
        sidecar_context: CodexSidecarLaunchContext {
            provider_exec_profile: true,
            config_args: terminal
                .provider_launch_context
                .as_ref()
                .and_then(|context| {
                    if let freshell_runtime_protocol::ProviderPreparation::Codex {
                        sidecar_args,
                        ..
                    } = &context.preparation
                    {
                        Some(sidecar_args.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_default(),
            env: child_secret_env.clone(),
        },
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
