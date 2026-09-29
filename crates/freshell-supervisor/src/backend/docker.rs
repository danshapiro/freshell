use freshell_runtime_protocol::{
    FreshAgentLaunchSpec, ProviderBootstrapFile, ProviderConfigRoot, ProviderLaunchContext,
    ProviderSecretReference, TerminalLaunchSpec,
};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

static CAPABILITY_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn configure_capability_dir(control_socket: &Path) -> Result<(), String> {
    let control_dir = control_socket
        .parent()
        .ok_or("managed runtime control socket has no parent")?;
    let control_dir = if control_dir.exists() {
        std::fs::canonicalize(control_dir).map_err(|error| error.to_string())?
    } else if control_dir.is_absolute() {
        control_dir.to_path_buf()
    } else {
        return Err("managed runtime control directory must be absolute".into());
    };
    let directory = std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| control_dir.join("mcp-capabilities"));
    CAPABILITY_DIR
        .set(directory)
        .map_err(|_| "managed MCP capability directory already configured".into())
}

/// Exact extra-mount set for a Phase 2 terminal workload. Every source is
/// canonicalized before Docker sees it; destinations preserve the host's
/// absolute workspace/git paths so Git worktrees keep their common-dir links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalMounts {
    pub workspace: PathBuf,
    pub git_common_dir: Option<PathBuf>,
    pub provider_bootstrap_files: Vec<PathBuf>,
    pub provider_secret_files: Vec<PathBuf>,
    pub provider_user_root: Option<PathBuf>,
    pub mcp_capability_file: Option<PathBuf>,
}

pub fn terminal_mounts(spec: &TerminalLaunchSpec) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
        &spec.provider_secret_references,
        spec.provider_launch_context.as_ref(),
        &spec.mode,
    )
}

pub fn fresh_agent_mounts(spec: &FreshAgentLaunchSpec) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
        &spec.provider_secret_references,
        spec.provider_launch_context.as_ref(),
        spec.provider.as_str(),
    )
}

fn workload_mounts(
    workspace_path: &str,
    cwd_path: &str,
    git_common_path: Option<&str>,
    bootstrap_files: &[ProviderBootstrapFile],
    secret_references: &[ProviderSecretReference],
    context: Option<&ProviderLaunchContext>,
    provider: &str,
) -> Result<TerminalMounts, String> {
    let workspace = canonical_dir(Path::new(workspace_path), "workspace")?;
    if workspace != Path::new(workspace_path) {
        return Err("workspace path must already be canonical".into());
    }
    let cwd = canonical_dir(Path::new(cwd_path), "cwd")?;
    if cwd != Path::new(cwd_path) {
        return Err("cwd path must already be canonical".into());
    }
    if !cwd.starts_with(&workspace) {
        return Err("terminal cwd must be inside the approved workspace".into());
    }
    reject_management_path(&workspace)?;
    let git_common_dir = git_common_path
        .map(|raw| -> Result<PathBuf, String> {
            let canonical = canonical_dir(Path::new(raw), "git common dir")?;
            if canonical != Path::new(raw) {
                return Err("git common dir must already be canonical".into());
            }
            Ok(canonical)
        })
        .transpose()?;
    if let Some(git) = &git_common_dir {
        reject_management_path(git)?;
    }
    let mut provider_bootstrap_files = Vec::with_capacity(bootstrap_files.len());
    for file in bootstrap_files {
        let source = std::fs::canonicalize(&file.source_path)
            .map_err(|error| format!("provider bootstrap file: {error}"))?;
        if !source.is_file() || source != Path::new(&file.source_path) {
            return Err("provider bootstrap file must be a canonical regular file".into());
        }
        reject_management_path(&source)?;
        provider_bootstrap_files.push(source);
    }
    let mut provider_secret_files = Vec::with_capacity(secret_references.len());
    for secret in secret_references {
        let source = std::fs::canonicalize(&secret.source_path)
            .map_err(|error| format!("provider secret reference: {error}"))?;
        if !source.is_file() || source != Path::new(&secret.source_path) {
            return Err("provider secret reference must be a canonical regular file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&source)
                .map_err(|error| error.to_string())?
                .permissions()
                .mode()
                & 0o077
                != 0
            {
                return Err("provider OneCLI grant must be private".into());
            }
        }
        reject_management_path(&source)?;
        provider_secret_files.push(source);
    }
    let provider_user_root =
        if let Some(capability) = context.and_then(|context| context.mcp_capability.as_ref()) {
            Some(approved_staged_provider_root(
                &capability_directory()?,
                &capability.grant_id,
            )?)
        } else if context.is_some() {
            let home = std::env::var_os("HOME");
            let relative = match provider {
                "claude" => ".claude",
                "codex" => ".codex",
                "opencode" => ".config/opencode",
                "amplifier" => ".amplifier",
                _ => return Err("unapproved provider user root".into()),
            };
            if let Some(home) = home
                .as_ref()
                .filter(|home| Path::new(home).join(relative).exists())
            {
                Some(approved_user_provider_root(Path::new(home), provider)?)
            } else if context.is_some_and(user_provider_config_referenced) {
                return Err("referenced provider user root is unavailable".into());
            } else {
                None
            }
        } else {
            None
        };
    let mcp_capability_file = context
        .and_then(|context| context.mcp_capability.as_ref())
        .map(|capability| {
            let directory = capability_directory()?;
            if !capability.grant_id.starts_with("grant-")
                || capability.grant_id.len() > 128
                || !capability
                    .grant_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("invalid managed MCP grant id".to_string());
            }
            let source = directory.join(format!("{}.json", capability.grant_id));
            let canonical = std::fs::canonicalize(&source)
                .map_err(|error| format!("managed MCP grant unavailable: {error}"))?;
            if canonical != source || !canonical.is_file() {
                return Err("managed MCP grant must be a canonical regular file".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(&canonical)
                    .map_err(|error| error.to_string())?
                    .permissions()
                    .mode()
                    & 0o077
                    != 0
                {
                    return Err("managed MCP grant must be private".into());
                }
            }
            Ok(canonical)
        })
        .transpose()?;
    Ok(TerminalMounts {
        workspace,
        git_common_dir,
        provider_bootstrap_files,
        provider_secret_files,
        provider_user_root,
        mcp_capability_file,
    })
}

fn capability_directory() -> Result<PathBuf, String> {
    let directory = CAPABILITY_DIR
        .get()
        .cloned()
        .or_else(|| std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").map(PathBuf::from))
        .ok_or("managed MCP capability directory is unavailable")?;
    std::fs::canonicalize(&directory)
        .map_err(|error| format!("managed MCP capability directory unavailable: {error}"))
}

pub(crate) fn staged_provider_root_for_grant(grant_id: &str) -> Result<PathBuf, String> {
    approved_staged_provider_root(&capability_directory()?, grant_id)
}

fn approved_staged_provider_root(directory: &Path, grant_id: &str) -> Result<PathBuf, String> {
    if !grant_id.starts_with("grant-")
        || grant_id.len() > 128
        || !grant_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid managed MCP grant id".into());
    }
    let expected = directory
        .parent()
        .ok_or("managed MCP capability directory has no parent")?
        .join("provider-roots")
        .join(grant_id);
    let canonical = canonical_dir(&expected, "managed provider root")?;
    if canonical != expected {
        return Err("managed provider root must be canonical".into());
    }
    Ok(canonical)
}

fn user_provider_config_referenced(context: &ProviderLaunchContext) -> bool {
    context
        .config
        .iter()
        .any(|reference| reference.root == ProviderConfigRoot::UserProvider)
        || matches!(
            &context.preparation,
            freshell_runtime_protocol::ProviderPreparation::Opencode { project_config, tui_config, .. }
                if project_config.iter().chain(tui_config.iter())
                    .any(|reference| reference.root == ProviderConfigRoot::UserProvider)
        )
}

fn approved_user_provider_root(home: &Path, provider: &str) -> Result<PathBuf, String> {
    let relative = match provider {
        "claude" => ".claude",
        "codex" => ".codex",
        "opencode" => ".config/opencode",
        "amplifier" => ".amplifier",
        _ => return Err("unapproved provider user root".into()),
    };
    let canonical_home = canonical_dir(home, "HOME")?;
    let root = canonical_dir(&canonical_home.join(relative), "provider user root")?;
    if !root.starts_with(canonical_home) {
        return Err("provider user root escaped HOME".into());
    }
    reject_management_path(&root)?;
    Ok(root)
}

fn canonical_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("{label}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(canonical)
}

fn reject_management_path(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy();
    for forbidden in [
        "docker.sock",
        "/var/lib/freshell-supervisor",
        "/run/freshell-supervisor",
    ] {
        if text.contains(forbidden) {
            return Err(format!(
                "managed terminal mount exposes forbidden path {text}"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod provider_secret_tests {
    use super::*;

    #[test]
    fn managed_provider_root_is_derived_from_grant_not_supervisor_home() {
        let control = tempfile::tempdir().unwrap();
        let capabilities = control.path().join("mcp-capabilities");
        let staged = control.path().join("provider-roots/grant-test");
        std::fs::create_dir_all(&capabilities).unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        assert_eq!(
            approved_staged_provider_root(&capabilities, "grant-test").unwrap(),
            staged
        );
        assert!(approved_staged_provider_root(&capabilities, "../outside").is_err());
    }

    #[test]
    fn nested_opencode_user_config_requires_the_approved_root_mount() {
        use freshell_runtime_protocol::{ProviderConfigReference, ProviderPreparation};
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Opencode {
                project_config: vec![ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "opencode.json".into(),
                    provider_relative_path: ".config/opencode/opencode.json".into(),
                    format: "json".into(),
                }],
                tui_config: None,
                inline_config: false,
            },
            mcp_capability: None,
            config: vec![],
        };
        assert!(user_provider_config_referenced(&context));
    }

    #[test]
    fn provider_secret_user_root_is_approved_and_canonical() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        assert_eq!(
            approved_user_provider_root(home.path(), "claude").unwrap(),
            std::fs::canonicalize(home.path().join(".claude")).unwrap()
        );
        assert!(approved_user_provider_root(home.path(), "unknown").is_err());
    }

    #[test]
    fn provider_secret_fresh_agent_uses_the_same_reference_mount() {
        use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let grant = root.path().join("onecli.env");
        std::fs::write(&grant, "ANTHROPIC_API_KEY=fixture-secret-bytes\n").unwrap();
        std::fs::set_permissions(&grant, std::fs::Permissions::from_mode(0o600)).unwrap();
        let canonical_grant = std::fs::canonicalize(&grant).unwrap();
        let canonical_workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let mut launch: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
            "sessionId":"fresh-secret", "provider":"claude", "sessionType":"freshclaude",
            "runtimeVariant":"claude-sdk", "providerStoreId":"store-secret",
            "cwd":canonical_workspace, "workspacePath":canonical_workspace,
            "runAsUid":65534, "runAsGid":0
        }))
        .unwrap();
        launch.provider_secret_references = vec![ProviderSecretReference {
            source_path: canonical_grant.to_string_lossy().into_owned(),
            profile: ProviderSecretProfile::ClaudeOnecliEnvironment,
        }];
        let mounts = fresh_agent_mounts(&launch).unwrap();
        assert_eq!(mounts.provider_secret_files, vec![canonical_grant.clone()]);
        let durable = serde_json::to_string(&launch).unwrap();
        assert!(durable.contains(&canonical_grant.to_string_lossy().to_string()));
        assert!(!durable.contains("fixture-secret-bytes"));
    }
}
