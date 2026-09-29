use freshell_runtime_protocol::{
    FreshAgentLaunchSpec, ProviderBootstrapFile, ProviderConfigRoot, ProviderLaunchContext,
    ProviderSecretReference, TerminalLaunchSpec,
};
use std::path::{Path, PathBuf};

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
    let provider_user_root = if context.is_some_and(user_provider_config_referenced) {
        let home = std::env::var_os("HOME").ok_or("provider user config requires HOME")?;
        Some(approved_user_provider_root(Path::new(&home), provider)?)
    } else {
        None
    };
    Ok(TerminalMounts {
        workspace,
        git_common_dir,
        provider_bootstrap_files,
        provider_secret_files,
        provider_user_root,
    })
}

fn user_provider_config_referenced(context: &ProviderLaunchContext) -> bool {
    context
        .config
        .iter()
        .any(|reference| reference.root == ProviderConfigRoot::UserProvider)
        || matches!(
            &context.preparation,
            freshell_runtime_protocol::ProviderPreparation::Opencode { project_config, tui_config }
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

#[cfg(test)]
mod provider_secret_tests {
    use super::*;

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
