//! Provider-specific recovery probes executed inside the soul enclosure.
//!
//! The trusted host delegates store reads to a short-lived helper running as
//! the same unprivileged uid/gid as the provider. This avoids granting the host
//! DAC override while keeping all provider-state inspection inside the runtime.

mod claude;
mod cli;
mod codex;
#[cfg(feature = "fresh-agent-fixtures")]
mod deterministic_fresh_agent;
mod fresh_agent;
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

pub fn prepare_provider_state_before_bootstrap(
    terminal: &mut freshell_runtime_protocol::TerminalLaunchSpec,
) -> Result<(), String> {
    if terminal.mode != "amplifier" {
        return Ok(());
    }
    let session_id = terminal
        .resume_session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "managed Amplifier launch requires one exact launcher-assigned session id".to_string()
        })?;
    let provider_home = std::path::Path::new("/home/freshell/provider/.amplifier");
    let ensured = freshell_sessions::amplifier_stub::ensure_session(
        provider_home,
        session_id,
        &terminal.cwd,
        &terminal.terminal_id,
    )
    .map_err(|error| format!("prepare Amplifier session stub: {error}"))?;
    if let Some(recorded_cwd) = ensured.working_dir_of_existing {
        terminal.cwd = recorded_cwd;
    }
    Ok(())
}

pub async fn prepare_terminal(
    mut terminal: freshell_runtime_protocol::TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
) -> Result<PreparedTerminal, String> {
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
        prepare_provider_features(&terminal, "claude-mcp")?;
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
            let mut args = vec!["opencode-rebind"];
            if let Some(source) = source.as_deref() {
                args.push(source);
            }
            prepare_provider_features_for_identity(
                terminal.run_as_uid,
                terminal.run_as_gid,
                &args,
            )?;
            terminal.env.insert(
                "OPENCODE_TUI_CONFIG".into(),
                "/home/freshell/provider/.freshell/opencode/tui.json".into(),
            );
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

fn prepare_provider_features(
    terminal: &freshell_runtime_protocol::TerminalLaunchSpec,
    operation: &str,
) -> Result<(), String> {
    prepare_provider_features_for_identity(terminal.run_as_uid, terminal.run_as_gid, &[operation])
}

fn prepare_provider_features_for_identity(uid: u32, gid: u32, args: &[&str]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let status = std::process::Command::new("/usr/bin/setpriv")
        .args(crate::provider_identity_args(uid, gid))
        .arg(exe)
        .arg("prepare-provider-features")
        .args(args)
        .status()
        .map_err(|error| format!("prepare provider features: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "prepare provider features failed: {}",
            args.first().unwrap_or(&"unknown")
        ))
    }
}

pub fn prepare_fresh_agent_child_environment(
    launch: &freshell_runtime_protocol::FreshAgentLaunchSpec,
    child_env: &mut std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
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
        let mut args = vec!["opencode-rebind"];
        if let Some(source) = source.as_deref() {
            args.push(source);
        }
        prepare_provider_features_for_identity(launch.run_as_uid, launch.run_as_gid, &args)?;
        child_env.insert(
            "OPENCODE_TUI_CONFIG".into(),
            "/home/freshell/provider/.freshell/opencode/tui.json".into(),
        );
    }
    Ok(())
}

pub(crate) fn run_provider_features_worker(args: &[String]) -> Result<(), String> {
    let provider_home = std::path::Path::new("/home/freshell/provider");
    match args {
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
            .map(|_| ())
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
}
