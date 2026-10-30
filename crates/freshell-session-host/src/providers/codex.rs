use super::cli;
use freshell_agent_runtime::ProviderStoreProbe;
use freshell_codex::{
    launch_lifecycle::{
        CodexLaunchError, CodexLaunchSidecar, CodexTerminalLaunchManager, LaunchClass,
    },
    launch_plan::{
        codex_remote_args, CodexLaunchPlanInput, CodexSidecarLaunchContext,
        CODEX_INITIAL_LAUNCH_ATTEMPTS,
    },
    remote_proxy::RemoteProxyEvent,
};
use freshell_runtime_protocol::{ResumeSpec, RuntimeDiagnosticCode, TerminalLaunchSpec};
use std::sync::Arc;
use tokio::sync::mpsc;

use super::ProviderLaunchPreparationError;

pub struct PreparedCodexLaunch {
    pub sidecar: Arc<CodexLaunchSidecar>,
    pub events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    pub remote_args: [String; 4],
}

pub async fn prepare(
    terminal: &TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
) -> Result<PreparedCodexLaunch, ProviderLaunchPreparationError> {
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
        .map_err(provider_preparation_error)?;
    let remote_args = codex_remote_args(&launch.remote_ws_url)
        .map_err(|error| format!("invalid Codex proxy URL: {error:?}"))?;
    Ok(PreparedCodexLaunch {
        sidecar: launch.sidecar,
        events: launch.events,
        remote_args,
    })
}

fn provider_preparation_error(error: CodexLaunchError) -> ProviderLaunchPreparationError {
    let diagnostic_code = match &error {
        CodexLaunchError::Config(_) => Some(RuntimeDiagnosticCode::CodexConfigPlanningFailed),
        CodexLaunchError::AppServerStart(_) => {
            Some(RuntimeDiagnosticCode::CodexAppServerStartFailed)
        }
        CodexLaunchError::ProxyStart(_) => Some(RuntimeDiagnosticCode::CodexProxyStartFailed),
        CodexLaunchError::Failed(_) | CodexLaunchError::QueueFull | CodexLaunchError::Cancelled => {
            None
        }
    };
    let message = error.to_string();
    match diagnostic_code {
        Some(diagnostic_code) => {
            ProviderLaunchPreparationError::with_diagnostic_code(message, diagnostic_code)
        }
        None => message.into(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::launch_plan::CodexLaunchConfigError;

    #[test]
    fn codex_launch_stages_keep_body_free_diagnostics_and_other_errors_stay_generic() {
        let cases = [
            (
                CodexLaunchError::Config(CodexLaunchConfigError {
                    message: "invalid sandbox setting".into(),
                }),
                RuntimeDiagnosticCode::CodexConfigPlanningFailed,
            ),
            (
                CodexLaunchError::AppServerStart("local readiness detail".into()),
                RuntimeDiagnosticCode::CodexAppServerStartFailed,
            ),
            (
                CodexLaunchError::ProxyStart("local proxy detail".into()),
                RuntimeDiagnosticCode::CodexProxyStartFailed,
            ),
        ];

        for (error, expected_code) in cases {
            let preparation_error = provider_preparation_error(error);
            assert_eq!(
                preparation_error
                    .diagnostic_code_or(RuntimeDiagnosticCode::ProviderLaunchPrepareFailed),
                expected_code
            );
        }

        for error in [
            CodexLaunchError::Failed("unclassified local detail".into()),
            CodexLaunchError::QueueFull,
            CodexLaunchError::Cancelled,
        ] {
            let preparation_error = provider_preparation_error(error);
            assert_eq!(
                preparation_error
                    .diagnostic_code_or(RuntimeDiagnosticCode::ProviderLaunchPrepareFailed),
                RuntimeDiagnosticCode::ProviderLaunchPrepareFailed
            );
        }
    }
}
