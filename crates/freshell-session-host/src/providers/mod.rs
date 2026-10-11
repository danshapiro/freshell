//! Provider-specific recovery probes executed inside the soul enclosure.
//!
//! The trusted host delegates store reads to a short-lived helper running as
//! the same unprivileged uid/gid as the provider. This avoids granting the host
//! DAC override while keeping all provider-state inspection inside the runtime.

mod claude;
mod cli;
mod codex;
#[cfg(feature = "fresh-agent-fixtures")]
pub(crate) mod deterministic_fresh_agent;
mod fresh_agent;
pub(crate) mod native_identity;
mod opencode;

#[cfg(feature = "fresh-agent-fixtures")]
pub(crate) use deterministic_fresh_agent::run_state_worker as run_fresh_agent_fixture_state_worker;
#[cfg(feature = "fresh-agent-fixtures")]
pub(crate) use deterministic_fresh_agent::run_worker as run_fresh_agent_fixture_worker;
pub(crate) use fresh_agent::open_hosted_fresh_agent;

pub(crate) use codex::PreparedCodexLaunch;

use freshell_agent_runtime::ProviderStoreProbe;
use freshell_runtime_protocol::{
    CheckpointReference, RecoveryBlockReason, RecoveryPath, RecoveryProbe, ResumeSpec, RetryHint,
};

pub struct PreparedTerminal {
    pub terminal: freshell_runtime_protocol::TerminalLaunchSpec,
    pub codex: Option<codex::PreparedCodexLaunch>,
    pub child_env: std::collections::BTreeMap<String, String>,
}

pub fn prepare_provider_state_before_bootstrap_at(
    terminal: &mut freshell_runtime_protocol::TerminalLaunchSpec,
    provider_home: &std::path::Path,
    selected_user_root: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, String> {
    if terminal.mode != "amplifier" {
        return Ok(Vec::new());
    }
    let session_id = terminal
        .resume_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "managed Amplifier launch requires one exact launcher-assigned session id".to_string()
        })?;
    let amplifier_home = provider_home.join(".amplifier");
    let settings_home = if terminal
        .provider_launch_context
        .as_ref()
        .is_some_and(|context| {
            context.config.iter().any(|reference| {
                reference.root == freshell_runtime_protocol::ProviderConfigRoot::UserProvider
                    && reference.relative_path == "settings.yaml"
                    && reference.provider_relative_path == ".amplifier/settings.yaml"
            })
        }) {
        selected_user_root
    } else {
        &amplifier_home
    };
    let ensured = freshell_sessions::amplifier_stub::ensure_session_with_settings_home(
        &amplifier_home,
        session_id,
        &terminal.cwd,
        &terminal.terminal_id,
        settings_home,
    )
    .map_err(|error| format!("prepare Amplifier session stub: {error}"))?;
    if let Some(recorded_cwd) = ensured.working_dir_of_existing {
        terminal.cwd = recorded_cwd;
    }
    Ok(ensured.created_paths)
}

pub async fn prepare_terminal(
    terminal: freshell_runtime_protocol::TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
) -> Result<PreparedTerminal, String> {
    prepare_terminal_with_provider_feature_runner(
        terminal,
        child_secret_env,
        prepare_provider_features_for_identity,
    )
    .await
}

async fn prepare_terminal_with_provider_feature_runner<F>(
    mut terminal: freshell_runtime_protocol::TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
    prepare_features: F,
) -> Result<PreparedTerminal, String>
where
    F: Fn(u32, u32, &[&str]) -> Result<Option<String>, String>,
{
    let mut child_env = child_secret_env.clone();
    if let Some(context) = terminal.provider_launch_context.as_ref() {
        if let Some(capability) = context.mcp_capability.as_ref() {
            if capability.endpoint.is_empty() {
                return Err("managed MCP endpoint is unavailable".into());
            }
            let grant = read_mcp_grant(std::path::Path::new("/run/freshell/mcp-capability.json"))?;
            if grant.get("FRESHELL_URL") != Some(&capability.endpoint) {
                return Err("managed MCP grant endpoint differs from launch context".into());
            }
            probe_managed_endpoint(&capability.endpoint).await?;
            child_env.extend(grant);
        }
    }
    if terminal.mode == "claude"
        && terminal
            .provider_launch_context
            .as_ref()
            .is_some_and(|context| context.mcp_capability.is_some())
    {
        prepare_features(terminal.run_as_uid, terminal.run_as_gid, &["claude-mcp"])?;
    }
    if terminal.mode == "amplifier" {
        let bundle = match terminal
            .provider_launch_context
            .as_ref()
            .map(|context| &context.preparation)
        {
            Some(freshell_runtime_protocol::ProviderPreparation::Amplifier { bundle, .. }) => {
                bundle.as_str()
            }
            _ => return Err("managed Amplifier launch lacks its selected ordinary bundle".into()),
        };
        prepare_features(
            terminal.run_as_uid,
            terminal.run_as_gid,
            &["amplifier-profile", bundle],
        )?;
    }
    if terminal.mode == "opencode" {
        if let Some(context) = terminal.provider_launch_context.as_ref() {
            if let freshell_runtime_protocol::ProviderPreparation::Opencode {
                tui_config,
                inline_config,
                ..
            } = &context.preparation
            {
                if let Some(reference) = tui_config {
                    terminal.env.insert(
                        "OPENCODE_TUI_CONFIG".into(),
                        format!(
                            "/home/freshell/provider/{}",
                            reference.provider_relative_path
                        ),
                    );
                }
                if *inline_config {
                    let raw = std::fs::read_to_string(
                        "/run/freshell-private/user-provider/ephemeral/inline-config.json",
                    )
                    .map_err(|_| "managed OpenCode inline config is unavailable")?;
                    terminal.env.insert("OPENCODE_CONFIG_CONTENT".into(), raw);
                }
            }
        }
        let rebind_disabled = matches!(
            terminal
                .env
                .get("FRESHELL_OPENCODE_REBIND")
                .map(String::as_str),
            Some("0" | "false")
        );
        if !rebind_disabled {
            let source = terminal
                .env
                .get("OPENCODE_TUI_CONFIG")
                .or_else(|| child_env.get("OPENCODE_TUI_CONFIG"))
                .cloned();
            prepare_opencode_rebind_tui_config(
                &mut terminal.env,
                terminal.run_as_uid,
                terminal.run_as_gid,
                source.as_deref(),
                &prepare_features,
            )?;
        }
        let permission = terminal
            .env
            .remove("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION");
        let has_mcp = terminal
            .provider_launch_context
            .as_ref()
            .is_some_and(|context| context.mcp_capability.is_some());
        let plan = freshell_platform::opencode_config::prepare_opencode_config(
            std::path::Path::new(&terminal.cwd),
            std::path::Path::new("/home/freshell/provider/.config/opencode"),
        )
        .map_err(|error| error.to_string())?;
        let inherited = terminal
            .env
            .get("OPENCODE_CONFIG_CONTENT")
            .or_else(|| child_env.get("OPENCODE_CONFIG_CONTENT"));
        if inherited.is_some() || permission.is_some() || has_mcp {
            let config = freshell_platform::opencode_config::merge_owned_entries(
                inherited.map(String::as_str),
                &plan,
                &freshell_platform::opencode_config::OwnedConfigEdits {
                    disable_snapshots: false,
                    bash_permission: permission,
                    freshell_command: has_mcp
                        .then(|| vec!["node".into(), "/opt/freshell-mcp/server.js".into()]),
                },
            )
            .map_err(|error| error.to_string())?;
            terminal
                .env
                .insert("OPENCODE_CONFIG_CONTENT".into(), config.clone());
            child_env.insert("OPENCODE_CONFIG_CONTENT".into(), config);
        }
    }
    apply_terminal_context(&mut terminal)?;
    if terminal.mode == "codex" {
        let mut sidecar_env = terminal.env.clone();
        sidecar_env.extend(child_env.clone());
        let prepared = codex::prepare(&terminal, &sidecar_env).await?;
        let mut args = prepared.remote_args.to_vec();
        args.extend(terminal.args);
        terminal.args = args;
        return Ok(PreparedTerminal {
            terminal,
            codex: Some(prepared),
            child_env,
        });
    }
    Ok(PreparedTerminal {
        terminal,
        codex: None,
        child_env,
    })
}

fn read_mcp_grant(
    path: &std::path::Path,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "managed MCP grant is unavailable".to_string())?,
    )
    .map_err(|_| "managed MCP grant is malformed".to_string())?;
    let endpoint = value
        .get("endpoint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            value.starts_with("http://host.docker.internal:")
                || value.starts_with("https://host.docker.internal:")
        })
        .ok_or_else(|| "managed MCP endpoint is invalid".to_string())?;
    let scope = value
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| "managed MCP scope is invalid".to_string())?;
    Ok([
        ("FRESHELL".into(), "1".into()),
        ("FRESHELL_URL".into(), endpoint.into()),
        ("FRESHELL_TOKEN".into(), scope.into()),
    ]
    .into_iter()
    .collect())
}

async fn probe_managed_endpoint(endpoint: &str) -> Result<(), String> {
    let url =
        url::Url::parse(endpoint).map_err(|_| "managed MCP endpoint is invalid".to_string())?;
    if url.host_str() != Some("host.docker.internal") {
        return Err("managed MCP endpoint is not the host gateway".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "managed MCP endpoint port is missing".to_string())?;
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect(("host.docker.internal", port)),
    )
    .await
    .map_err(|_| "managed MCP host gateway did not accept a connection".to_string())?
    .map_err(|_| "managed MCP host gateway is unreachable".to_string())?;
    Ok(())
}

fn prepare_provider_features_for_identity(
    uid: u32,
    gid: u32,
    args: &[&str],
) -> Result<Option<String>, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = std::process::Command::new("/usr/bin/setpriv")
        .args(crate::provider_identity_args(uid, gid))
        .arg(exe)
        .arg("prepare-provider-features")
        .args(args)
        .output()
        .map_err(|error| format!("prepare provider features: {error}"))?;
    finish_provider_feature_worker(args.first().copied().unwrap_or("unknown"), uid, gid, output)
}

fn finish_provider_feature_worker(
    operation: &str,
    uid: u32,
    gid: u32,
    output: std::process::Output,
) -> Result<Option<String>, String> {
    finish_provider_feature_worker_at_phase(operation, uid, gid, "feature_worker", output)
}

#[derive(Default)]
struct AmplifierProfileFailureContext {
    phase: Option<String>,
    exception: Option<String>,
    native_exit_code: Option<i64>,
    native_signal: Option<i64>,
}

fn amplifier_profile_failure_context(stderr: &[u8]) -> AmplifierProfileFailureContext {
    let mut result = AmplifierProfileFailureContext::default();
    for line in stderr.split(|byte| *byte == b'\n') {
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        let helper = event["event"] == "amplifier.selected_profile.failed";
        let native_process = event["event"] == "provider.feature_preparation.failed"
            && event["operation"] == "amplifier-profile"
            && event["phase"] == "native_profile_process";
        if !helper && !native_process {
            continue;
        }
        let phase = event[if helper { "phase" } else { "profile_phase" }].as_str();
        if let Some(
            phase @ ("load_native_settings"
            | "validate_bundle"
            | "read_bundle"
            | "validate_providers"
            | "write_native_settings"
            | "verify_native_settings"),
        ) = phase
        {
            result.phase = Some(phase.to_owned());
        }
        if let Some(exception) = event[if helper {
            "exception_type"
        } else {
            "profile_exception"
        }]
        .as_str()
        {
            if !exception.is_empty()
                && exception.len() <= 64
                && exception
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            {
                result.exception = Some(exception.to_owned());
            }
        }
        if native_process {
            result.native_exit_code = event["exit_code"].as_i64();
            result.native_signal = event["signal"].as_i64();
        }
    }
    result
}

fn finish_provider_feature_worker_at_phase(
    operation: &str,
    uid: u32,
    gid: u32,
    phase: &str,
    output: std::process::Output,
) -> Result<Option<String>, String> {
    if !output.status.success() {
        #[cfg(unix)]
        let signal = std::os::unix::process::ExitStatusExt::signal(&output.status);
        #[cfg(not(unix))]
        let signal: Option<i32> = None;
        let profile = if operation == "amplifier-profile" {
            amplifier_profile_failure_context(&output.stderr)
        } else {
            AmplifierProfileFailureContext::default()
        };
        crate::emit_environment_event(serde_json::json!({
            "event": "provider.feature_preparation.failed",
            "severity": "error",
            "operation": operation,
            "phase": phase,
            "exit_code": output.status.code(),
            "signal": signal,
            "uid": uid,
            "gid": gid,
            "stdout_bytes": output.stdout.len(),
            "stderr_bytes": output.stderr.len(),
            "profile_phase": profile.phase,
            "profile_exception": profile.exception,
            "native_exit_code": profile.native_exit_code,
            "native_signal": profile.native_signal,
        }));
        if operation == "amplifier-profile" {
            let mut detail = format!(
                "phase={phase}, exit_code={}, signal={}",
                output
                    .status
                    .code()
                    .map_or_else(|| "none".into(), |code| code.to_string()),
                signal.map_or_else(|| "none".into(), |signal| signal.to_string())
            );
            if let Some(code) = profile.native_exit_code {
                detail.push_str(&format!(", native_exit_code={code}"));
            }
            if let Some(signal) = profile.native_signal {
                detail.push_str(&format!(", native_signal={signal}"));
            }
            if let Some(phase) = profile.phase {
                detail.push_str(&format!(", profile_phase={phase}"));
            }
            if let Some(exception) = profile.exception {
                detail.push_str(&format!(", profile_exception={exception}"));
            }
            return Err(format!(
                "prepare provider features failed: {operation} ({detail})"
            ));
        }
        let _ = std::io::Write::write_all(&mut std::io::stderr(), &output.stderr);
        return Err(format!("prepare provider features failed: {operation}"));
    }
    parse_provider_feature_worker_output(operation, &output.stdout)
}

fn parse_provider_feature_worker_output(
    operation: &str,
    stdout: &[u8],
) -> Result<Option<String>, String> {
    if operation != "opencode-rebind" {
        return Ok(None);
    }
    let output = std::str::from_utf8(stdout)
        .map_err(|_| "OpenCode rebind worker returned an invalid selector path".to_string())?;
    let path = output.trim_end_matches(['\r', '\n']);
    if path.is_empty() || path.contains(['\r', '\n']) || !std::path::Path::new(path).is_absolute() {
        return Err("OpenCode rebind worker did not return one absolute selector path".into());
    }
    Ok(Some(path.to_owned()))
}

fn prepare_opencode_rebind_tui_config<F>(
    env: &mut std::collections::BTreeMap<String, String>,
    uid: u32,
    gid: u32,
    source: Option<&str>,
    prepare_features: &F,
) -> Result<(), String>
where
    F: Fn(u32, u32, &[&str]) -> Result<Option<String>, String>,
{
    let mut args = vec!["opencode-rebind"];
    if let Some(source) = source {
        args.push(source);
    }
    let selector = prepare_features(uid, gid, &args)?
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "OpenCode rebind worker returned no selector path".to_string())?;
    env.insert("OPENCODE_TUI_CONFIG".into(), selector);
    Ok(())
}

pub fn prepare_fresh_agent_child_environment(
    launch: &freshell_runtime_protocol::FreshAgentLaunchSpec,
    child_env: &mut std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    prepare_fresh_agent_child_environment_with_provider_feature_runner(
        launch,
        child_env,
        prepare_provider_features_for_identity,
    )
}

fn prepare_fresh_agent_child_environment_with_provider_feature_runner<F>(
    launch: &freshell_runtime_protocol::FreshAgentLaunchSpec,
    child_env: &mut std::collections::BTreeMap<String, String>,
    prepare_features: F,
) -> Result<(), String>
where
    F: Fn(u32, u32, &[&str]) -> Result<Option<String>, String>,
{
    use freshell_runtime_protocol::{FreshProvider, ProviderPreparation};
    if launch.provider != FreshProvider::Opencode {
        return Ok(());
    }
    if let Some(context) = launch.provider_launch_context.as_ref() {
        if let ProviderPreparation::Opencode {
            tui_config,
            inline_config,
            ..
        } = &context.preparation
        {
            if let Some(reference) = tui_config {
                child_env.insert(
                    "OPENCODE_TUI_CONFIG".into(),
                    format!(
                        "/home/freshell/provider/{}",
                        reference.provider_relative_path
                    ),
                );
            }
            if *inline_config {
                let raw = std::fs::read_to_string(
                    "/run/freshell-private/user-provider/ephemeral/inline-config.json",
                )
                .map_err(|_| "managed OpenCode inline config is unavailable")?;
                child_env.insert("OPENCODE_CONFIG_CONTENT".into(), raw);
            }
        }
    }
    let plan = freshell_platform::opencode_config::prepare_opencode_config(
        std::path::Path::new(&launch.cwd),
        std::path::Path::new("/home/freshell/provider/.config/opencode"),
    )
    .map_err(|error| error.to_string())?;
    if let Some(inherited) = child_env.get("OPENCODE_CONFIG_CONTENT") {
        let normalized = freshell_platform::opencode_config::merge_owned_entries(
            Some(inherited),
            &plan,
            &freshell_platform::opencode_config::OwnedConfigEdits::default(),
        )
        .map_err(|error| error.to_string())?;
        child_env.insert("OPENCODE_CONFIG_CONTENT".into(), normalized);
    }
    if !matches!(
        child_env
            .get("FRESHELL_OPENCODE_REBIND")
            .map(String::as_str),
        Some("0" | "false")
    ) {
        let source = child_env.get("OPENCODE_TUI_CONFIG").cloned();
        prepare_opencode_rebind_tui_config(
            child_env,
            launch.run_as_uid,
            launch.run_as_gid,
            source.as_deref(),
            &prepare_features,
        )?;
    }
    Ok(())
}

pub(crate) fn run_provider_features_worker(
    args: &[String],
) -> Result<Option<std::path::PathBuf>, String> {
    run_provider_features_worker_at(args, std::path::Path::new("/home/freshell/provider"))
}

fn run_provider_features_worker_at(
    args: &[String],
    provider_home: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, String> {
    match args {
        [operation, bundle] if operation == "amplifier-profile" => {
            let output = std::process::Command::new("/opt/amplifier-src/.venv/bin/python")
                .arg("/opt/prepare-amplifier-profile.py")
                .arg(bundle)
                .env("HOME", provider_home)
                .current_dir(provider_home)
                .output()
                .map_err(|_| "native Amplifier profile preparation did not start")?;
            finish_provider_feature_worker_at_phase(
                "amplifier-profile",
                unsafe { libc::geteuid() },
                unsafe { libc::getegid() },
                "native_profile_process",
                output,
            )
            .map(|_| None)
        }
        [operation] if operation == "claude-mcp" => {
            use std::os::unix::fs::OpenOptionsExt;
            let destination = provider_home.join(".claude/freshell-mcp.json");
            std::fs::create_dir_all(destination.parent().unwrap())
                .map_err(|error| error.to_string())?;
            let bytes = serde_json::to_vec(&serde_json::json!({
                "mcpServers":{"freshell":{"command":"node","args":["/opt/freshell-mcp/server.js"]}}
            }))
            .map_err(|error| error.to_string())?;
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(destination)
                .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
                .map_err(|error| error.to_string())
                .map(|()| None)
        }
        [operation] | [operation, _] if operation == "opencode-rebind" => {
            let selected = args.get(1).map(std::path::Path::new);
            if let Some(selected) = selected {
                let canonical = std::fs::canonicalize(selected)
                    .map_err(|_| "managed OpenCode TUI source is unavailable".to_string())?;
                if !canonical.starts_with(provider_home) {
                    return Err("managed OpenCode TUI source is outside the provider home".into());
                }
            }
            freshell_platform::opencode_plugin::ensure_rebind_plugin_with_user_config(
                provider_home,
                selected,
            )
            .map(Some)
            .map_err(|error| error.to_string())
        }
        _ => Err("unknown provider feature preparation".into()),
    }
}

fn apply_terminal_context(
    terminal: &mut freshell_runtime_protocol::TerminalLaunchSpec,
) -> Result<(), String> {
    use freshell_runtime_protocol::ProviderPreparation;
    let Some(context) = &terminal.provider_launch_context else {
        return Ok(());
    };
    context
        .validate(&terminal.mode)
        .map_err(|error| error.message)?;
    let rewrite = |arg: &String| {
        if (terminal.mode == "claude" && arg == ".claude/freshell-mcp.json")
            || context
                .mcp_capability
                .as_ref()
                .is_some_and(|capability| arg == &capability.provider_relative_path)
        {
            format!("/home/freshell/provider/{arg}")
        } else {
            arg.clone()
        }
    };
    let prepared_args = match &context.preparation {
        ProviderPreparation::Claude { mcp_args } => mcp_args.iter().map(rewrite).collect(),
        ProviderPreparation::Codex { tui_args, .. } => tui_args.iter().map(rewrite).collect(),
        ProviderPreparation::Opencode { .. } => Vec::new(),
        ProviderPreparation::Amplifier {
            bundle,
            resume_args,
        } => {
            let mut args = Vec::new();
            if bundle != "default" {
                args.extend(["--bundle".into(), bundle.clone()]);
            }
            args.extend(resume_args.iter().map(rewrite));
            args
        }
    };
    let insert_at = match &context.preparation {
        ProviderPreparation::Claude { .. } => terminal
            .args
            .windows(2)
            .position(|pair| pair[0] == "--settings")
            .map_or(0, |index| index + 2),
        ProviderPreparation::Codex { .. } => terminal
            .args
            .windows(2)
            .position(|pair| pair[0] == "-c" && pair[1].starts_with("tui.notifications="))
            .map_or(0, |index| index + 2),
        ProviderPreparation::Opencode { .. } | ProviderPreparation::Amplifier { .. } => 0,
    };
    terminal.args.splice(insert_at..insert_at, prepared_args);
    Ok(())
}

pub async fn probe_resume(
    mut resume_spec: ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> RecoveryProbe {
    let provider = resume_spec.provider_session.provider.clone();
    let result = match resume_spec.fixture_transport {
        Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic) => {
            deterministic_resume_probe(&resume_spec, run_as_uid, run_as_gid).await
        }
        None => match provider.as_str() {
            "claude" | "kilroy" => claude::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "codex" => codex::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "opencode" => opencode::probe(&resume_spec, run_as_uid, run_as_gid).await,
            "amplifier" | "phase1-fixture" | "native-session-fixture" => {
                cli::probe_as_provider(&resume_spec, run_as_uid, run_as_gid).await
            }
            other => Err(format!(
                "managed recovery probe is not implemented for provider {other}"
            )),
        },
    };
    match result {
        Ok(ProviderStoreProbe::Ready { evidence }) => {
            resume_spec.claude_fork = None;
            if matches!(
                provider.as_str(),
                "phase1-fixture" | "native-session-fixture"
            ) {
                if let Some(revision) = evidence.iter().find_map(|item| {
                    item.strip_prefix("checkpointRevision=")
                        .and_then(|value| value.parse::<u64>().ok())
                }) {
                    resume_spec.checkpoint_revision = revision;
                    resume_spec.checkpoint_references = if revision == 0 {
                        Vec::new()
                    } else {
                        vec![CheckpointReference {
                            kind: "native_session_fixture".into(),
                            reference: format!(
                                "provider://.freshell/checkpoints/native-session/{revision}.json"
                            ),
                            revision,
                            verified: true,
                        }]
                    };
                }
            }
            RecoveryProbe::ResumeReady {
                evidence_revision: resume_spec.evidence_revision,
                resume_spec: Box::new(resume_spec),
            }
        }
        Ok(ProviderStoreProbe::ParentBackedClaudeFork { .. }) => RecoveryProbe::ResumeReady {
            evidence_revision: resume_spec.evidence_revision,
            resume_spec: Box::new(resume_spec),
        },
        Ok(ProviderStoreProbe::DefinitivelyUnavailable {
            reason,
            evidence,
            store_state,
        }) => RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::NativeResume,
            reason,
            evidence,
            store_state,
        },
        Ok(ProviderStoreProbe::Blocked {
            reason,
            retry_hint,
            evidence,
        }) => RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason,
            retry_hint,
            evidence,
        },
        Err(message) => RecoveryProbe::Blocked {
            path: RecoveryPath::NativeResume,
            reason: RecoveryBlockReason::ImplementationUnavailable,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: Some(message.clone()),
            },
            evidence: vec![message],
        },
    }
}

#[cfg(feature = "fresh-agent-fixtures")]
async fn deterministic_resume_probe(
    spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    deterministic_fresh_agent::probe_resume(
        spec,
        std::path::Path::new(&spec.provider_home)
            .join(".freshell-fixture")
            .as_path(),
        run_as_uid,
        run_as_gid,
    )
    .await
}

#[cfg(not(feature = "fresh-agent-fixtures"))]
async fn deterministic_resume_probe(
    _spec: &ResumeSpec,
    _run_as_uid: u32,
    _run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    Err("deterministic fresh-agent recovery is absent from this session-host build".into())
}

pub fn run_probe_worker(args: &[String]) -> Result<(), String> {
    cli::run_probe_worker(args)
}

#[cfg(test)]
mod provider_secret_context_tests {
    use super::*;
    use freshell_runtime_protocol::{
        McpCapabilityReference, ProviderLaunchContext, ProviderPreparation,
    };

    #[test]
    fn scoped_mcp_grant_becomes_provider_process_environment() {
        let grant = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            grant.path(),
            r#"{"endpoint":"http://host.docker.internal:3001","scope":"fixture-scope"}"#,
        )
        .unwrap();
        let env = read_mcp_grant(grant.path()).unwrap();
        assert_eq!(
            env.get("FRESHELL_URL").map(String::as_str),
            Some("http://host.docker.internal:3001")
        );
        assert_eq!(
            env.get("FRESHELL_TOKEN").map(String::as_str),
            Some("fixture-scope")
        );
        assert_eq!(env.get("FRESHELL").map(String::as_str), Some("1"));
    }

    #[test]
    fn feature_worker_nonzero_exit_preserves_opaque_error_and_selector_stdout() {
        let owned = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        let run_owned = |script: &str| {
            std::process::Command::new("/bin/sh")
                .args(["-c", script])
                .current_dir(owned.path())
                .env("HOME", owned.path())
                .output()
                .unwrap()
        };
        let output =
            run_owned("printf private-fixture-stdout; printf private-fixture-stderr >&2; exit 23");
        assert_eq!(output.status.code(), Some(23));
        let result = finish_provider_feature_worker("amplifier-profile", uid, gid, output);
        assert_eq!(
            result.unwrap_err(),
            "prepare provider features failed: amplifier-profile (phase=feature_worker, exit_code=23, signal=none)"
        );
        let output = run_owned("printf '/owned/selector.json\\n'");
        assert_eq!(
            finish_provider_feature_worker("opencode-rebind", uid, gid, output).unwrap(),
            Some("/owned/selector.json".into())
        );
    }

    #[test]
    fn feature_worker_spawned_failure_reports_body_free_exit_status() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "providers::provider_secret_context_tests::feature_worker_nonzero_exit_preserves_opaque_error_and_selector_stdout", "--nocapture"]).output().unwrap();
        assert!(output.status.success(), "owned behavior child failed");
        assert!(
            std::str::from_utf8(&output.stdout)
                .unwrap()
                .contains("test result: ok. 1 passed;"),
            "actual spawned behavior must execute exactly one test"
        );
        let events = std::str::from_utf8(&output.stderr)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>();
        assert_eq!(
            events.len(),
            1,
            "actual nonzero worker status must produce one structured refusal"
        );
        assert_eq!(events[0]["event"], "provider.feature_preparation.failed");
        assert_eq!(events[0]["severity"], "error");
        assert_eq!(events[0]["operation"], "amplifier-profile");
        assert_eq!(events[0]["exit_code"], 23);
        assert!(events[0]["signal"].is_null());
        assert_eq!(events[0]["uid"], unsafe { libc::geteuid() });
        assert_eq!(events[0]["gid"], unsafe { libc::getegid() });
        assert!(events[0]["stdout_bytes"].as_u64().unwrap() > 0);
        assert!(events[0]["stderr_bytes"].as_u64().unwrap() > 0);
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("private-fixture"));
        assert!(!serde_json::to_string(&events).unwrap().contains("/owned"));
    }

    #[test]
    fn amplifier_profile_failure_reaches_caller_without_private_output() {
        let owned = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", "printf '%s\\n' '{\"event\":\"amplifier.selected_profile.failed\",\"severity\":\"error\",\"phase\":\"read_bundle\",\"exception_type\":\"FileNotFoundError\"}' >&2; printf private-fixture-details >&2; exit 19"])
            .current_dir(owned.path())
            .output()
            .unwrap();
        let error = finish_provider_feature_worker(
            "amplifier-profile",
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            output,
        )
        .unwrap_err();
        assert!(
            error.contains("exit_code=19"),
            "actual worker exit must reach caller: {error}"
        );
        assert!(
            error.contains("profile_phase=read_bundle"),
            "native phase must reach caller: {error}"
        );
        assert!(
            error.contains("profile_exception=FileNotFoundError"),
            "native exception class must reach caller: {error}"
        );
        assert!(!error.contains("private-fixture"));
    }

    #[test]
    fn native_profile_failure_survives_both_worker_boundaries() {
        const CHILD: &str = "FRESHELL_TEST_NATIVE_PROFILE_FAILURE_CHILD";
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        if std::env::var_os(CHILD).is_some() {
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", "printf '%s\\n' '{\"event\":\"amplifier.selected_profile.failed\",\"phase\":\"write_native_settings\",\"exception_type\":\"PermissionError\"}' >&2; printf private-fixture-details >&2; exit 17"])
                .output()
                .unwrap();
            let error = finish_provider_feature_worker_at_phase(
                "amplifier-profile",
                uid,
                gid,
                "native_profile_process",
                output,
            )
            .unwrap_err();
            assert!(error.contains("exit_code=17"));
            std::process::exit(1);
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "providers::provider_secret_context_tests::native_profile_failure_survives_both_worker_boundaries", "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-fixture"));
        let error =
            finish_provider_feature_worker("amplifier-profile", uid, gid, output).unwrap_err();
        assert!(error.contains("exit_code=1"));
        assert!(error.contains("native_exit_code=17"));
        assert!(error.contains("profile_phase=write_native_settings"));
        assert!(error.contains("profile_exception=PermissionError"));
    }

    #[test]
    fn amplifier_profile_failure_does_not_copy_unrecognized_diagnostics() {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", "printf '%s\\n' '{\"event\":\"amplifier.selected_profile.failed\",\"phase\":\"private-fixture-phase\",\"exception_type\":\"private-fixture-error\"}' >&2; exit 11"])
            .output()
            .unwrap();
        let error = finish_provider_feature_worker(
            "amplifier-profile",
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() },
            output,
        )
        .unwrap_err();
        assert!(error.contains("exit_code=11"));
        assert!(!error.contains("private-fixture"));
        assert!(!error.contains("profile_phase="));
        assert!(!error.contains("profile_exception="));
    }

    #[test]
    fn provider_secret_context_becomes_provider_native_argv_at_spawn() {
        let mut terminal: freshell_runtime_protocol::TerminalLaunchSpec =
            serde_json::from_value(serde_json::json!({
                "terminalId":"terminal-context", "streamId":"stream-context", "mode":"claude",
                "program":"claude", "args":["--settings","{}","--plugin-dir","/workspace/plugins/ordinary","--session-id","native-one"], "cwd":"/workspace",
                "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,
                "projectKey":"project-context","workspacePath":"/workspace"
            }))
            .unwrap();
        terminal.provider_launch_context = Some(ProviderLaunchContext {
            preparation: ProviderPreparation::Claude {
                mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
            },
            mcp_capability: Some(McpCapabilityReference {
                grant_id: "grant-context".into(),
                endpoint: "http://host.docker.internal:3001/api/mcp".into(),
                provider_relative_path: ".claude/freshell-mcp.json".into(),
                host_gateway_address: None,
            }),
            config: Vec::new(),
        });
        apply_terminal_context(&mut terminal).unwrap();
        assert_eq!(
            terminal.args,
            [
                "--settings",
                "{}",
                "--mcp-config",
                "/home/freshell/provider/.claude/freshell-mcp.json",
                "--plugin-dir",
                "/workspace/plugins/ordinary",
                "--session-id",
                "native-one"
            ]
        );
    }

    #[tokio::test]
    async fn managed_amplifier_prepares_only_selected_ordinary_profile() {
        let mut terminal: freshell_runtime_protocol::TerminalLaunchSpec =
            serde_json::from_value(serde_json::json!({
                "terminalId":"terminal-amplifier-profile", "streamId":"stream-amplifier-profile",
                "mode":"amplifier", "program":"amplifier", "args":["run","--mode","chat"],
                "cwd":"/workspace", "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,
                "projectKey":"selected-profile","workspacePath":"/workspace"
            }))
            .unwrap();
        terminal.provider_launch_context = Some(ProviderLaunchContext {
            preparation: ProviderPreparation::Amplifier {
                bundle: "default".into(),
                resume_args: vec![],
            },
            config: vec![],
            mcp_capability: None,
        });
        let invoked = std::cell::Cell::new(0);
        let prepared = prepare_terminal_with_provider_feature_runner(
            terminal,
            &std::collections::BTreeMap::new(),
            |uid, gid, args| {
                assert_eq!((uid, gid), (65534, 0));
                assert_eq!(args, ["amplifier-profile", "default"]);
                invoked.set(invoked.get() + 1);
                Ok(None)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            invoked.get(),
            1,
            "selected profile must be prepared under provider identity"
        );
        assert_eq!(prepared.terminal.args, ["run", "--mode", "chat"]);
        let refusal = "prepare provider features failed: amplifier-profile (phase=feature_worker, exit_code=1, signal=none, profile_phase=read_bundle, profile_exception=FileNotFoundError)";
        let result = prepare_terminal_with_provider_feature_runner(
            prepared.terminal,
            &std::collections::BTreeMap::new(),
            |_, _, _| Err(refusal.into()),
        )
        .await;
        assert_eq!(
            result.err().unwrap(),
            refusal,
            "preparation refusal must reach the existing launch caller"
        );
    }

    #[tokio::test]
    async fn managed_terminal_uses_worker_returned_opencode_tui_selector_path() {
        let workspace = tempfile::tempdir().unwrap();
        let source = "/home/freshell/provider/.config/opencode/user-tui.jsonc";
        let generated = "/home/freshell/provider/.freshell/opencode/tui-abc123.json";
        let mut terminal: freshell_runtime_protocol::TerminalLaunchSpec =
            serde_json::from_value(serde_json::json!({
                "terminalId":"terminal-selected-tui", "streamId":"stream-selected-tui",
                "mode":"opencode", "program":"opencode", "args":[],
                "env":{"OPENCODE_TUI_CONFIG":source}, "cwd":workspace.path(),
                "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24,
                "projectKey":"selected-tui", "workspacePath":workspace.path()
            }))
            .unwrap();
        terminal
            .env
            .insert("OPENCODE_TUI_CONFIG".into(), source.into());

        let prepared = prepare_terminal_with_provider_feature_runner(
            terminal,
            &std::collections::BTreeMap::new(),
            |uid, gid, args| {
                assert_eq!((uid, gid), (65534, 0));
                assert_eq!(args, ["opencode-rebind", source]);
                Ok(Some(generated.into()))
            },
        )
        .await
        .unwrap();

        assert_eq!(
            prepared.terminal.env.get("OPENCODE_TUI_CONFIG"),
            Some(&generated.to_string())
        );
    }

    #[test]
    fn managed_fresh_opencode_uses_worker_returned_tui_selector_path() {
        let workspace = tempfile::tempdir().unwrap();
        let source = "/home/freshell/provider/.config/opencode/user-tui.jsonc";
        let generated = "/home/freshell/provider/.freshell/opencode/tui-def456.json";
        let launch: freshell_runtime_protocol::FreshAgentLaunchSpec =
            serde_json::from_value(serde_json::json!({
                "sessionId":"fresh-selected-tui", "provider":"opencode",
                "sessionType":"freshopencode", "runtimeVariant":"default",
                "providerStoreId":"fresh-selected-tui-store", "cwd":workspace.path(),
                "workspacePath":workspace.path(), "runAsUid":65534,"runAsGid":0
            }))
            .unwrap();
        let mut child_env = std::collections::BTreeMap::from([(
            "OPENCODE_TUI_CONFIG".to_string(),
            source.to_string(),
        )]);

        prepare_fresh_agent_child_environment_with_provider_feature_runner(
            &launch,
            &mut child_env,
            |uid, gid, args| {
                assert_eq!((uid, gid), (65534, 0));
                assert_eq!(args, ["opencode-rebind", source]);
                Ok(Some(generated.into()))
            },
        )
        .unwrap();

        assert_eq!(
            child_env.get("OPENCODE_TUI_CONFIG").map(String::as_str),
            Some(generated)
        );
    }

    #[test]
    fn opencode_feature_worker_returns_the_materialized_selected_selector() {
        let provider_home = tempfile::tempdir().unwrap();
        let source = provider_home.path().join("user-tui.jsonc");
        std::fs::write(&source, r#"{"theme":"dark","plugin":["file:///user.ts"]}"#).unwrap();
        let args = vec!["opencode-rebind".to_string(), source.display().to_string()];

        let generated = run_provider_features_worker_at(&args, provider_home.path())
            .unwrap()
            .unwrap();
        assert!(generated.starts_with(provider_home.path().join(".freshell/opencode")));
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&generated).unwrap()).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["plugin"][0], "file:///user.ts");
        assert_eq!(config["plugin"].as_array().unwrap().len(), 2);

        let stdout = format!("{}\n", generated.display());
        assert_eq!(
            parse_provider_feature_worker_output("opencode-rebind", stdout.as_bytes()).unwrap(),
            Some(generated.display().to_string())
        );
        assert_eq!(
            parse_provider_feature_worker_output("claude-mcp", b"").unwrap(),
            None
        );
    }

    #[test]
    fn opencode_feature_worker_returns_default_selector_path_without_selection() {
        let provider_home = tempfile::tempdir().unwrap();
        let args = vec!["opencode-rebind".to_string()];

        let generated = run_provider_features_worker_at(&args, provider_home.path())
            .unwrap()
            .unwrap();

        assert_eq!(
            generated,
            freshell_platform::opencode_plugin::tui_config_path(provider_home.path())
        );
        assert_eq!(
            std::fs::read_to_string(generated).unwrap(),
            freshell_platform::opencode_plugin::tui_config_content(
                &freshell_platform::opencode_plugin::rebind_plugin_path(provider_home.path())
            )
        );
    }

    #[test]
    fn opencode_feature_worker_output_rejects_missing_or_ambiguous_selector_paths() {
        for stdout in [b"".as_slice(), b"relative/path\n", b"/one\n/two\n"] {
            assert!(parse_provider_feature_worker_output("opencode-rebind", stdout).is_err());
        }
    }
}
