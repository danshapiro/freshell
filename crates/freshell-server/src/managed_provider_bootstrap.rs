use freshell_runtime_protocol::ProviderSecretReference;
use freshell_runtime_protocol::{
    McpCapabilityReference, ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext,
    ProviderPreparation,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub fn provider_launch_context(provider: &str, workspace: &Path) -> Option<ProviderLaunchContext> {
    provider_launch_context_for_managed(provider, workspace, None)
}

pub fn provider_launch_context_for_managed(
    provider: &str,
    workspace: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Option<ProviderLaunchContext> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    provider_launch_context_from_home(provider, workspace, &home, mcp_capability)
}

pub(crate) fn provider_launch_context_from_home(
    provider: &str,
    workspace: &Path,
    home: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Option<ProviderLaunchContext> {
    let mcp_enabled = mcp_capability.is_some();
    let (root, entries, preparation) = match provider {
        "claude" => (
            ".claude",
            &[
                "settings.json",
                "settings.local.json",
                "CLAUDE.md",
                "plugins",
                "skills",
                "commands",
                "hooks",
                "agents",
            ][..],
            ProviderPreparation::Claude {
                mcp_args: if mcp_enabled {
                    vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()]
                } else {
                    Vec::new()
                },
            },
        ),
        "codex" => (
            ".codex",
            &["config.toml", "AGENTS.md", "skills", "rules"][..],
            ProviderPreparation::Codex {
                tui_args: if mcp_enabled {
                    managed_codex_mcp_args()?
                } else {
                    Vec::new()
                },
                sidecar_args: if mcp_enabled {
                    managed_codex_mcp_args()?
                } else {
                    Vec::new()
                },
            },
        ),
        "opencode" => (
            ".config/opencode",
            &[
                "opencode.json",
                "opencode.jsonc",
                "plugins",
                "agents",
                "commands",
                "skills",
            ][..],
            ProviderPreparation::Opencode {
                project_config: Vec::new(),
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
        ),
        "amplifier" => (
            ".amplifier",
            &["config.yaml", "config.yml", "bundles", "skills", "agents"][..],
            ProviderPreparation::Amplifier {
                bundle: "default".into(),
                resume_args: Vec::new(),
            },
        ),
        _ => return None,
    };
    let preparation = match preparation {
        ProviderPreparation::Opencode { tui_config, .. } => {
            let project_config = [
                "opencode.json",
                "opencode.jsonc",
                ".opencode/opencode.json",
                ".opencode/opencode.jsonc",
            ]
            .into_iter()
            .filter_map(|entry| {
                let source = approved_config_path(workspace, entry)?;
                if !source.is_file() {
                    return None;
                }
                Some(ProviderConfigReference {
                    root: ProviderConfigRoot::Workspace,
                    relative_path: entry.into(),
                    provider_relative_path: format!(".config/opencode/project/{entry}"),
                    format: if entry.ends_with(".jsonc") {
                        "jsonc"
                    } else {
                        "json"
                    }
                    .into(),
                })
            })
            .collect();
            ProviderPreparation::Opencode {
                project_config,
                tui_config,
                tui_source: None,
                inline_config: false,
            }
        }
        other => other,
    };
    let provider_root = home.join(root);
    let mut selected = entries
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    if let Ok(discovered) = std::fs::read_dir(&provider_root) {
        for item in discovered.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let extension = Path::new(&name)
                .extension()
                .and_then(|value| value.to_str());
            if matches!(
                extension,
                Some("json" | "jsonc" | "toml" | "yaml" | "yml" | "md")
            ) && !matches!(
                name.to_ascii_lowercase().as_str(),
                ".credentials.json"
                    | "auth.json"
                    | "keys.env"
                    | ".env"
                    | "credentials"
                    | "secrets"
                    | "token.json"
            ) {
                selected.insert(name);
            }
        }
    }
    let config = selected
        .into_iter()
        .filter_map(|entry| {
            let path = approved_config_path(&provider_root, &entry)?;
            let format = if path.is_dir() {
                "directory"
            } else if path.is_file() {
                match path.extension().and_then(|value| value.to_str()) {
                    Some("json") => "json",
                    Some("jsonc") => "jsonc",
                    Some("toml") => "toml",
                    Some("yaml" | "yml") => "yaml",
                    _ => "text",
                }
            } else {
                return None;
            };
            Some(ProviderConfigReference {
                root: ProviderConfigRoot::UserProvider,
                relative_path: entry.clone(),
                provider_relative_path: format!("{root}/{entry}"),
                format: format.into(),
            })
        })
        .collect();
    Some(ProviderLaunchContext {
        preparation,
        mcp_capability,
        config,
    })
}

struct ManagedImageMcpRuntime;

impl freshell_platform::mcp_inject::McpRuntime for ManagedImageMcpRuntime {
    fn tmp_dir(&self) -> PathBuf {
        PathBuf::from("/tmp")
    }
    fn is_wsl_environment(&self) -> bool {
        false
    }
    fn convert_to_windows_path(&self, path: &str) -> String {
        path.into()
    }
    fn server_command_args(
        &self,
    ) -> Result<
        Vec<freshell_platform::mcp_inject::McpServerArg>,
        freshell_platform::mcp_inject::McpInjectError,
    > {
        Ok(vec![freshell_platform::mcp_inject::McpServerArg::Path(
            "/opt/freshell-mcp/server.js".into(),
        )])
    }
}

fn managed_codex_mcp_args() -> Option<Vec<String>> {
    let renderings = freshell_platform::mcp_inject::build_managed_codex_mcp_renderings(
        &ManagedImageMcpRuntime,
        &freshell_platform::RealEnv,
        freshell_platform::HostOs::Linux,
        false,
        freshell_platform::cli_launch::ProviderTarget::Unix,
    )
    .ok()?;
    Some(renderings.tui.args)
}

/// Ordinary symlinked configs are included only when each resolved component
/// remains in the approved provider or workspace root.
fn approved_config_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let mut current = canonical_root.clone();
    for component in Path::new(relative).components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return None;
        }
        current = std::fs::canonicalize(current.join(component.as_os_str())).ok()?;
        if !current.starts_with(&canonical_root) {
            return None;
        }
    }
    Some(current)
}

pub fn named_provider_onecli_references(
    provider: &str,
) -> Result<Vec<ProviderSecretReference>, String> {
    use freshell_runtime_protocol::ProviderSecretProfile;
    let (prefix, environment, auth_file) = match provider {
        "claude" => (
            "CLAUDE",
            ProviderSecretProfile::ClaudeOnecliEnvironment,
            ProviderSecretProfile::ClaudeOnecliAuthFile,
        ),
        "codex" => (
            "CODEX",
            ProviderSecretProfile::CodexOnecliEnvironment,
            ProviderSecretProfile::CodexOnecliAuthFile,
        ),
        "opencode" => (
            "OPENCODE",
            ProviderSecretProfile::OpencodeOnecliEnvironment,
            ProviderSecretProfile::OpencodeOnecliAuthFile,
        ),
        "amplifier" => (
            "AMPLIFIER",
            ProviderSecretProfile::AmplifierOnecliEnvironment,
            ProviderSecretProfile::AmplifierOnecliKeysFile,
        ),
        _ => return Ok(Vec::new()),
    };
    let mut references = Vec::new();
    for (suffix, profile) in [("ENV_FILE", environment), ("AUTH_FILE", auth_file)] {
        let key = format!("FRESHELL_MANAGED_{prefix}_ONECLI_{suffix}");
        if let Some(path) = std::env::var_os(&key).filter(|value| !value.is_empty()) {
            let path = std::path::PathBuf::from(path);
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("{key}: OneCLI grant unavailable: {error}"))?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(format!("{key}: OneCLI grant must be a regular file"));
            }
            #[cfg(unix)]
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(format!("{key}: OneCLI grant must be private"));
            }
            let source_path = std::fs::canonicalize(path)
                .map_err(|error| format!("{key}: OneCLI grant unavailable: {error}"))?
                .to_string_lossy()
                .into_owned();
            references.push(ProviderSecretReference {
                source_path,
                profile,
            });
        }
    }
    Ok(references)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn managed_claude_provider_context_renders_scoped_mcp_recipe() {
        let workspace = tempfile::tempdir().unwrap();
        let capability = freshell_runtime_protocol::McpCapabilityReference {
            grant_id: "grant-fixture".into(),
            endpoint: "http://host.docker.internal:3001".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = provider_launch_context_for_managed(
            "claude",
            workspace.path(),
            Some(capability.clone()),
        )
        .unwrap();
        assert_eq!(context.mcp_capability, Some(capability));
        assert_eq!(
            context.preparation,
            ProviderPreparation::Claude {
                mcp_args: vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()],
            }
        );
        context.validate("claude").unwrap();
    }

    #[test]
    fn managed_codex_provider_context_renders_tui_and_sidecar_mcp() {
        let workspace = tempfile::tempdir().unwrap();
        let capability = freshell_runtime_protocol::McpCapabilityReference {
            grant_id: "grant-fixture".into(),
            endpoint: "http://host.docker.internal:3001".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context =
            provider_launch_context_for_managed("codex", workspace.path(), Some(capability))
                .unwrap();
        let ProviderPreparation::Codex {
            tui_args,
            sidecar_args,
        } = context.preparation
        else {
            panic!("Codex preparation missing");
        };
        assert!(!tui_args.is_empty());
        assert_eq!(tui_args, sidecar_args);
        assert!(tui_args.iter().any(|arg| arg.contains("freshell-mcp")));
    }

    #[test]
    fn replacement_context_discovers_new_top_level_provider_config() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let first =
            provider_launch_context_from_home("claude", workspace.path(), home.path(), None)
                .unwrap();
        assert!(!first
            .config
            .iter()
            .any(|item| item.relative_path == "new-policy.jsonc"));
        fs::write(home.path().join(".claude/new-policy.jsonc"), "{}").unwrap();
        fs::write(home.path().join(".claude/keybindings.json"), "{}").unwrap();
        let replacement =
            provider_launch_context_from_home("claude", workspace.path(), home.path(), None)
                .unwrap();
        assert!(replacement
            .config
            .iter()
            .any(|item| item.relative_path == "new-policy.jsonc"));
        assert!(replacement
            .config
            .iter()
            .any(|item| item.relative_path == "keybindings.json"));
    }

    #[test]
    fn named_provider_launch_context_uses_only_approved_nonsecret_roots() {
        for provider in ["claude", "codex", "opencode", "amplifier"] {
            let context = provider_launch_context(provider, Path::new("/tmp")).unwrap();
            context.validate(provider).unwrap();
            assert!(context.validate("different-provider").is_err());
            assert!(context.config.iter().all(|reference| {
                reference.root == ProviderConfigRoot::UserProvider
                    && !reference.relative_path.contains("auth")
                    && !reference.relative_path.contains("credentials")
                    && !reference.relative_path.contains("keys.env")
            }));
        }
        assert!(provider_launch_context("kilroy", Path::new("/tmp")).is_none());
    }

    #[test]
    fn opencode_context_names_existing_workspace_configuration() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("opencode.json"), "{}").unwrap();
        fs::create_dir_all(workspace.path().join(".opencode")).unwrap();
        fs::write(
            workspace.path().join(".opencode/opencode.jsonc"),
            "// ordinary config\n{}",
        )
        .unwrap();
        let context = provider_launch_context("opencode", workspace.path()).unwrap();
        assert!(
            matches!(context.preparation, ProviderPreparation::Opencode { ref project_config, .. }
            if project_config.iter().any(|reference| reference.root == ProviderConfigRoot::Workspace
                && reference.relative_path == "opencode.json"))
        );
        assert!(
            matches!(context.preparation, ProviderPreparation::Opencode { ref project_config, .. }
            if project_config.iter().any(|reference| reference.relative_path == ".opencode/opencode.jsonc"
                && reference.format == "jsonc"))
        );
        context.validate("opencode").unwrap();
    }

    #[test]
    fn opencode_context_accepts_in_root_links_and_omits_escaping_links() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        fs::create_dir_all(workspace.join("inside")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(workspace.join("inside/opencode.json"), "{}").unwrap();
        fs::write(outside.join("opencode.json"), "{}").unwrap();
        symlink(
            workspace.join("inside/opencode.json"),
            workspace.join("opencode.json"),
        )
        .unwrap();
        symlink(&outside, workspace.join(".opencode")).unwrap();
        let context = provider_launch_context("opencode", &workspace).unwrap();
        let ProviderPreparation::Opencode { project_config, .. } = context.preparation else {
            panic!("expected OpenCode preparation");
        };
        assert!(project_config
            .iter()
            .any(|entry| entry.relative_path == "opencode.json"));
        assert!(!project_config
            .iter()
            .any(|entry| entry.relative_path == ".opencode/opencode.json"));
    }
}
