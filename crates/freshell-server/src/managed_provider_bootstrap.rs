use freshell_runtime_protocol::ProviderSecretReference;
use freshell_runtime_protocol::{
    McpCapabilityReference, ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext,
    ProviderPreparation,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[cfg(test)]
pub fn provider_launch_context(provider: &str, workspace: &Path) -> Option<ProviderLaunchContext> {
    provider_launch_context_for_managed(provider, workspace, None)
}

#[cfg(test)]
pub fn provider_launch_context_for_managed(
    provider: &str,
    workspace: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Option<ProviderLaunchContext> {
    let home = tempfile::tempdir().unwrap();
    provider_launch_context_from_home_at(
        provider,
        workspace,
        workspace,
        home.path(),
        mcp_capability,
    )
    .expect("provider discovery")
}

pub fn provider_launch_context_for_managed_at(
    provider: &str,
    workspace: &Path,
    project_dir: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Result<Option<ProviderLaunchContext>, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    provider_launch_context_from_home_at(provider, workspace, project_dir, &home, mcp_capability)
}

pub(crate) fn provider_launch_context_from_home(
    provider: &str,
    workspace: &Path,
    home: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Result<Option<ProviderLaunchContext>, String> {
    provider_launch_context_from_home_at(provider, workspace, workspace, home, mcp_capability)
}

pub(crate) fn provider_launch_context_from_home_at(
    provider: &str,
    workspace: &Path,
    project_dir: &Path,
    home: &Path,
    mcp_capability: Option<McpCapabilityReference>,
) -> Result<Option<ProviderLaunchContext>, String> {
    let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    provider_launch_context_from_home_at_with_xdg(
        provider,
        workspace,
        project_dir,
        home,
        xdg_config_home.as_deref(),
        mcp_capability,
    )
}

pub(crate) fn provider_launch_context_from_home_at_with_xdg(
    provider: &str,
    workspace: &Path,
    project_dir: &Path,
    home: &Path,
    xdg_config_home: Option<&Path>,
    mcp_capability: Option<McpCapabilityReference>,
) -> Result<Option<ProviderLaunchContext>, String> {
    provider_launch_context_from_home_at_with_selected_roots(
        provider,
        workspace,
        project_dir,
        home,
        xdg_config_home,
        mcp_capability,
        &[],
    )
}

pub(crate) fn provider_launch_context_from_home_at_with_selected_roots(
    provider: &str,
    workspace: &Path,
    project_dir: &Path,
    home: &Path,
    xdg_config_home: Option<&Path>,
    mcp_capability: Option<McpCapabilityReference>,
    selected_roots: &[freshell_platform::opencode_recipe::DiscoveryRoot],
) -> Result<Option<ProviderLaunchContext>, String> {
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
                mcp_args: Vec::new(),
            },
        ),
        "codex" => (
            ".codex",
            &["config.toml", "AGENTS.md", "skills", "rules"][..],
            ProviderPreparation::Codex {
                tui_args: Vec::new(),
                sidecar_args: Vec::new(),
            },
        ),
        "opencode" => (
            ".config/opencode",
            &[
                "opencode.json",
                "opencode.jsonc",
                "plugin",
                "plugins",
                "agents",
                "commands",
                "skills",
                "node_modules",
                "package.json",
                "package-lock.json",
                "pnpm-lock.yaml",
                "yarn.lock",
                "bun.lock",
                "bun.lockb",
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
        _ => return Ok(None),
    };
    let preparation = match preparation {
        ProviderPreparation::Opencode { tui_config, .. } => {
            let project_relative = project_dir
                .strip_prefix(workspace)
                .map_err(|_| "managed project is outside workspace")?;
            let mut project_config = Vec::new();
            for entry in [
                "opencode.json",
                "opencode.jsonc",
                ".opencode/opencode.json",
                ".opencode/opencode.jsonc",
            ] {
                let relative_path = project_relative.join(entry);
                let relative_path = relative_path
                    .to_str()
                    .ok_or("managed config path is not UTF-8")?
                    .replace(std::path::MAIN_SEPARATOR, "/");
                if !optional_resource_exists(
                    &workspace.join(&relative_path),
                    &relative_path,
                    "workspace",
                )? {
                    continue;
                }
                let source = approved_config_path(workspace, &relative_path, "workspace")?;
                let mounted_workspace = std::fs::canonicalize(workspace)
                    .map_err(|_| "mounted managed workspace is unavailable")?;
                let selected_workspace_root = selected_roots.iter().any(|root| {
                    root.role == freshell_platform::opencode_recipe::DiscoveryRole::Workspace
                        && root.logical_path.starts_with(workspace)
                        && workspace
                            .join(&relative_path)
                            .starts_with(&root.logical_path)
                        && std::fs::canonicalize(&root.logical_path)
                            .ok()
                            .is_some_and(|canonical| {
                                canonical.is_dir()
                                    && canonical != Path::new("/")
                                    && canonical != home
                                    && source.starts_with(canonical)
                            })
                });
                if !source.starts_with(&mounted_workspace) && !selected_workspace_root {
                    return Err(discovery_refusal(
                        "workspace",
                        &relative_path,
                        "outside_workspace",
                        "repair the link inside the mounted workspace and retry",
                    ));
                }
                if !source.is_file() {
                    return Err(discovery_refusal(
                        "workspace",
                        &relative_path,
                        "not_regular_file",
                        "select a regular configuration file and retry",
                    ));
                }
                project_config.push(ProviderConfigReference {
                    root: ProviderConfigRoot::Workspace,
                    relative_path: relative_path.clone(),
                    provider_relative_path: format!(".config/opencode/project/{relative_path}"),
                    format: if entry.ends_with(".jsonc") {
                        "jsonc"
                    } else {
                        "json"
                    }
                    .into(),
                });
            }
            ProviderPreparation::Opencode {
                project_config,
                tui_config,
                tui_source: None,
                inline_config: false,
            }
        }
        other => other,
    };
    let default_xdg_config_home = home.join(".config");
    let provider_root = if provider == "opencode" {
        xdg_config_home
            .unwrap_or(&default_xdg_config_home)
            .join("opencode")
    } else {
        home.join(root)
    };
    let mut selected = entries
        .iter()
        .map(|entry| (*entry).to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    if optional_resource_exists(&provider_root, ".", "user_provider")? {
        let root_enumeration_error = |error: std::io::Error| {
            discovery_refusal(
                "user_provider",
                ".",
                &format!("{:?}", error.kind()),
                "repair the provider root directory, its link, or permissions and retry",
            )
        };
        for item in std::fs::read_dir(&provider_root).map_err(root_enumeration_error)? {
            let item = item.map_err(root_enumeration_error)?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| "provider resource name is not UTF-8")?;
            let extension = Path::new(&name)
                .extension()
                .and_then(|value| value.to_str());
            if matches!(
                extension,
                Some("json" | "jsonc" | "toml" | "yaml" | "yml" | "md")
            ) && !matches!(
                name.as_str(),
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
    let mut config = Vec::new();
    for entry in selected {
        if !optional_resource_exists(&provider_root.join(&entry), &entry, "user_provider")? {
            continue;
        }
        let path = approved_config_path(&provider_root, &entry, "user_provider")?;
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
            return Err(discovery_refusal(
                "user_provider",
                &entry,
                "unsupported_node",
                "select a regular file or directory and retry",
            ));
        };
        config.push(ProviderConfigReference {
            root: ProviderConfigRoot::UserProvider,
            relative_path: entry.clone(),
            provider_relative_path: format!("{root}/{entry}"),
            format: format.into(),
        });
    }
    if provider == "codex"
        && optional_resource_exists(&home.join(".agents/skills"), ".agents/skills", "user_home")?
    {
        approved_config_path(home, ".agents/skills", "user_home")?;
        config.push(ProviderConfigReference {
            root: ProviderConfigRoot::UserProvider,
            relative_path: "freshell-discovered-agents".into(),
            provider_relative_path: ".codex/skills/freshell-discovered-agents".into(),
            format: "directory".into(),
        });
    }
    // One normal transport selection preserves the shared resource closure
    // identically in the host stage, without dependency rediscovery.
    config.push(ProviderConfigReference {
        root: ProviderConfigRoot::UserProvider,
        relative_path: ".freshell/resources".into(),
        provider_relative_path: ".freshell/resources".into(),
        format: "directory".into(),
    });
    if config.len() > 128 {
        return Err(
            "managed provider selections exceed 128; reduce unrelated top-level configurations"
                .into(),
        );
    }
    let context = ProviderLaunchContext {
        prepared_inputs: None,
        preparation,
        mcp_capability: None,
        config,
    };
    Ok(Some(match mcp_capability {
        Some(reference) => with_managed_mcp_reference(context, reference)?,
        None => context,
    }))
}

pub(crate) fn with_managed_mcp_reference(
    mut context: ProviderLaunchContext,
    reference: McpCapabilityReference,
) -> Result<ProviderLaunchContext, String> {
    match &mut context.preparation {
        ProviderPreparation::Claude { mcp_args } => {
            *mcp_args = vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()]
        }
        ProviderPreparation::Codex {
            tui_args,
            sidecar_args,
        } => {
            let args =
                managed_codex_mcp_args().ok_or("managed Codex MCP preparation unavailable")?;
            *tui_args = args.clone();
            *sidecar_args = args;
        }
        ProviderPreparation::Opencode { .. } | ProviderPreparation::Amplifier { .. } => {}
    }
    context.mcp_capability = Some(reference);
    Ok(context)
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

pub(crate) fn managed_codex_mcp_args() -> Option<Vec<String>> {
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

fn discovery_refusal(
    resource_root: &str,
    relative_path: &str,
    cause: &str,
    corrective_message: &str,
) -> String {
    // These fields come only from selectors and filesystem classifications:
    // never file contents, resolved link targets, or provider error payloads.
    tracing::warn!(
        event = "provider.environment.discovery.failed",
        resource_root,
        relative_path,
        cause,
        corrective_message,
    );
    format!("selected provider resource {relative_path}: {cause}; {corrective_message}")
}

/// Absence is optional only before a provider root/resource is selected.
fn optional_resource_exists(
    path: &Path,
    relative: &str,
    resource_root: &str,
) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(discovery_refusal(
            resource_root,
            relative,
            &format!("{:?}", error.kind()),
            "repair permissions and retry",
        )),
    }
}
fn approved_config_path(
    root: &Path,
    relative: &str,
    resource_root: &str,
) -> Result<PathBuf, String> {
    if relative.is_empty()
        || Path::new(relative)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("managed provider resource selector is unsafe".into());
    }
    std::fs::canonicalize(root.join(relative)).map_err(|error| {
        discovery_refusal(
            resource_root,
            relative,
            &format!("{:?}", error.kind()),
            "repair the selected resource or link and retry",
        )
    })
}

pub fn named_provider_onecli_references(
    provider: &str,
) -> Result<Vec<ProviderSecretReference>, String> {
    use freshell_runtime_protocol::ProviderSecretProfile;
    let (prefix, environment, auth_file, ca_file) = match provider {
        "claude" => (
            "CLAUDE",
            ProviderSecretProfile::ClaudeOnecliEnvironment,
            ProviderSecretProfile::ClaudeOnecliAuthFile,
            Some(ProviderSecretProfile::ClaudeOnecliCaFile),
        ),
        "codex" => (
            "CODEX",
            ProviderSecretProfile::CodexOnecliEnvironment,
            ProviderSecretProfile::CodexOnecliAuthFile,
            Some(ProviderSecretProfile::CodexOnecliCaFile),
        ),
        "opencode" => (
            "OPENCODE",
            ProviderSecretProfile::OpencodeOnecliEnvironment,
            ProviderSecretProfile::OpencodeOnecliAuthFile,
            Some(ProviderSecretProfile::OpencodeOnecliCaFile),
        ),
        "amplifier" => (
            "AMPLIFIER",
            ProviderSecretProfile::AmplifierOnecliEnvironment,
            ProviderSecretProfile::AmplifierOnecliKeysFile,
            Some(ProviderSecretProfile::AmplifierOnecliCaFile),
        ),
        _ => return Ok(Vec::new()),
    };
    let mut references = Vec::new();
    let mut profiles = vec![("ENV_FILE", environment), ("AUTH_FILE", auth_file)];
    if let Some(profile) = ca_file {
        profiles.push(("CA_FILE", profile));
    }
    for (suffix, profile) in profiles {
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
                provider_relative_path: None,
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
    fn named_provider_ca_references_resolve_exact_private_files_for_native_transports() {
        let mut env = crate::test_env_lock::TestEnv::lock_blocking();
        let root = tempfile::tempdir().unwrap();
        let ca = root.path().join("gateway-ca.pem");
        fs::write(&ca, "fixture-ca").unwrap();
        fs::set_permissions(&ca, fs::Permissions::from_mode(0o600)).unwrap();
        let names = [
            "FRESHELL_MANAGED_CLAUDE_ONECLI_CA_FILE",
            "FRESHELL_MANAGED_CODEX_ONECLI_CA_FILE",
            "FRESHELL_MANAGED_AMPLIFIER_ONECLI_CA_FILE",
        ];
        for (name, provider) in names.into_iter().zip(["claude", "codex", "amplifier"]) {
            env.set(name, &ca);
            let references = named_provider_onecli_references(provider).unwrap();
            let matching = references
                .iter()
                .filter(|reference| reference.source_path == ca.to_string_lossy())
                .collect::<Vec<_>>();
            assert_eq!(
                matching.len(),
                1,
                "{provider} needs a narrowly typed CA mount"
            );
            assert_eq!(
                matching[0].profile.provider_file_relative_path(),
                Some(".config/onecli/gateway-ca.pem")
            );
            fs::set_permissions(&ca, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(named_provider_onecli_references(provider).is_err());
            fs::set_permissions(&ca, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn named_opencode_onecli_references_include_private_environment_auth_and_ca_files() {
        let mut env = crate::test_env_lock::TestEnv::lock_blocking();
        let workspace = tempfile::tempdir().unwrap();
        let environment = workspace.path().join("opencode.env");
        let auth = workspace.path().join("opencode-auth.json");
        let ca = workspace.path().join("gateway-ca.pem");
        for file in [&environment, &auth, &ca] {
            fs::write(file, "fixture").unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let keys = [
            "FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE",
            "FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE",
            "FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE",
        ];
        for (key, file) in keys.into_iter().zip([&environment, &auth, &ca]) {
            env.set(key, file);
        }

        let references = named_provider_onecli_references("opencode").unwrap();

        assert_eq!(
            references
                .iter()
                .map(|reference| reference.profile)
                .collect::<Vec<_>>(),
            vec![
                freshell_runtime_protocol::ProviderSecretProfile::OpencodeOnecliEnvironment,
                freshell_runtime_protocol::ProviderSecretProfile::OpencodeOnecliAuthFile,
                freshell_runtime_protocol::ProviderSecretProfile::OpencodeOnecliCaFile,
            ],
        );
        let actual_paths = references
            .iter()
            .map(|reference| reference.source_path.clone())
            .collect::<Vec<_>>();
        let expected_paths = [environment, auth, ca].map(|file| {
            fs::canonicalize(file)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        });
        assert_eq!(actual_paths, expected_paths.to_vec());
    }

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
    fn opencode_selects_complete_installed_dependency_and_package_forms() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let provider = home.path().join(".config/opencode");
        fs::create_dir_all(provider.join("node_modules/package")).unwrap();
        fs::write(provider.join("node_modules/package/auth.json"), "ordinary").unwrap();
        for name in [
            "package.json",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
        ] {
            fs::write(provider.join(name), "fixture").unwrap();
        }
        let context = provider_launch_context_from_home_at_with_xdg(
            "opencode",
            workspace.path(),
            workspace.path(),
            home.path(),
            None,
            None,
        )
        .unwrap()
        .unwrap();
        for name in [
            "node_modules",
            "package.json",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
        ] {
            assert!(
                context
                    .config
                    .iter()
                    .any(|reference| reference.relative_path == name),
                "missing resource selection {name}"
            );
        }
        context.validate("opencode").unwrap();
    }
    #[test]
    fn codex_selects_discovered_agents_skills_without_native_state() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".agents/skills/fixture/scripts")).unwrap();
        fs::write(
            home.path().join(".agents/skills/fixture/SKILL.md"),
            "fixture",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".codex/sessions")).unwrap();
        let context = provider_launch_context_from_home_at_with_xdg(
            "codex",
            workspace.path(),
            workspace.path(),
            home.path(),
            None,
            None,
        )
        .unwrap()
        .unwrap();
        assert!(context
            .config
            .iter()
            .any(
                |reference| reference.relative_path == "freshell-discovered-agents"
                    && reference
                        .provider_relative_path
                        .starts_with(".codex/skills/")
            ));
        assert!(!context
            .config
            .iter()
            .any(|reference| reference.relative_path == "sessions"));
        context.validate("codex").unwrap();
    }
    #[test]
    fn selected_dangling_provider_resource_is_an_actionable_error() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join(".claude")).unwrap();
        std::os::unix::fs::symlink("missing", home.path().join(".claude/skills")).unwrap();
        let error = provider_launch_context_from_home_at_with_xdg(
            "claude",
            workspace.path(),
            workspace.path(),
            home.path(),
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("skills") && error.contains("repair"));
    }

    #[test]
    fn replacement_context_discovers_new_top_level_provider_config() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        let first =
            provider_launch_context_from_home("claude", workspace.path(), home.path(), None)
                .unwrap()
                .unwrap();
        assert!(!first
            .config
            .iter()
            .any(|item| item.relative_path == "new-policy.jsonc"));
        fs::write(home.path().join(".claude/new-policy.jsonc"), "{}").unwrap();
        fs::write(home.path().join(".claude/keybindings.json"), "{}").unwrap();
        let replacement =
            provider_launch_context_from_home("claude", workspace.path(), home.path(), None)
                .unwrap()
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
    fn opencode_context_uses_project_directory_beneath_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let project = workspace.path().join("nested-project");
        fs::create_dir_all(project.join(".opencode")).unwrap();
        fs::write(project.join(".opencode/opencode.json"), "{}").unwrap();
        fs::write(project.join(".opencode/opencode.jsonc"), "{ // user\n}").unwrap();
        let context = provider_launch_context_from_home_at(
            "opencode",
            workspace.path(),
            &project,
            home.path(),
            None,
        )
        .unwrap()
        .unwrap();
        let ProviderPreparation::Opencode { project_config, .. } = context.preparation else {
            panic!("expected OpenCode preparation");
        };
        assert!(project_config
            .iter()
            .any(|source| source.relative_path == "nested-project/.opencode/opencode.json"));
        assert!(project_config
            .iter()
            .any(|source| source.relative_path == "nested-project/.opencode/opencode.jsonc"));
    }

    #[test]
    fn opencode_context_carries_global_plugin_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let plugin = home.path().join(".config/opencode/plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(
            plugin.join("user-plugin.ts"),
            "export const User = async () => ({})",
        )
        .unwrap();
        let context =
            provider_launch_context_from_home("opencode", workspace.path(), home.path(), None)
                .unwrap()
                .unwrap();
        assert!(context.config.iter().any(
            |reference| reference.relative_path == "plugin" && reference.format == "directory"
        ));
    }

    #[test]
    fn opencode_context_uses_effective_xdg_config_home_for_global_sources() {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let xdg = tempfile::tempdir().unwrap();
        let global = xdg.path().join("opencode");
        fs::create_dir_all(global.join("plugin")).unwrap();
        fs::write(global.join("opencode.jsonc"), "{ // xdg global\n}").unwrap();
        fs::write(global.join("plugin/user.ts"), "export default {}\n").unwrap();
        fs::create_dir_all(home.path().join(".config/opencode")).unwrap();
        fs::write(home.path().join(".config/opencode/opencode.json"), "{}").unwrap();

        let context = provider_launch_context_from_home_at_with_xdg(
            "opencode",
            workspace.path(),
            workspace.path(),
            home.path(),
            Some(xdg.path()),
            None,
        )
        .unwrap()
        .unwrap();

        assert!(context.config.iter().any(|reference| {
            reference.relative_path == "opencode.jsonc" && reference.format == "jsonc"
        }));
        assert!(context.config.iter().any(|reference| {
            reference.relative_path == "plugin" && reference.format == "directory"
        }));
        assert_eq!(
            context
                .config
                .iter()
                .filter(|reference| reference.relative_path == ".freshell/resources")
                .count(),
            1
        );
        assert!(context
            .config
            .iter()
            .filter(|reference| reference.relative_path != ".freshell/resources")
            .all(|reference| reference
                .provider_relative_path
                .starts_with(".config/opencode/")));
        assert!(!context
            .config
            .iter()
            .any(|reference| reference.relative_path == "opencode.json"));
        context.validate("opencode").unwrap();
    }

    #[test]
    fn opencode_context_accepts_in_root_links_and_refuses_unmounted_project_links() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let outside = root.path().join("outside");
        let home = root.path().join("home");
        fs::create_dir_all(workspace.join("inside")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(workspace.join("inside/opencode.json"), "{}").unwrap();
        fs::write(outside.join("opencode.json"), "{}").unwrap();
        symlink(
            workspace.join("inside/opencode.json"),
            workspace.join("opencode.json"),
        )
        .unwrap();
        let context = provider_launch_context_from_home_at_with_xdg(
            "opencode", &workspace, &workspace, &home, None, None,
        )
        .unwrap()
        .unwrap();
        let ProviderPreparation::Opencode { project_config, .. } = context.preparation else {
            panic!("OpenCode preparation");
        };
        assert!(project_config
            .iter()
            .any(|entry| entry.relative_path == "opencode.json"));
        symlink(&outside, workspace.join(".opencode")).unwrap();
        assert!(provider_launch_context_from_home_at_with_xdg(
            "opencode", &workspace, &workspace, &home, None, None
        )
        .is_err());
    }

    #[test]
    fn opencode_project_alias_requires_its_selected_workspace_resource_mount() {
        use freshell_platform::opencode_recipe::{DiscoveryRole, DiscoveryRoot};
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let shared = root.path().join("shared");
        let home = root.path().join("home");
        for directory in [&workspace, &shared, &home] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(shared.join("opencode.json"), "{}").unwrap();
        symlink(&shared, workspace.join(".opencode")).unwrap();
        symlink(&shared, home.join(".opencode")).unwrap();
        let selected = DiscoveryRoot {
            logical_path: workspace.join(".opencode"),
            role: DiscoveryRole::Workspace,
        };
        let prepare = |roots: &[DiscoveryRoot]| {
            provider_launch_context_from_home_at_with_selected_roots(
                "opencode", &workspace, &workspace, &home, None, None, roots,
            )
        };
        let context = prepare(std::slice::from_ref(&selected)).unwrap().unwrap();
        let ProviderPreparation::Opencode { project_config, .. } = context.preparation else {
            panic!("OpenCode preparation");
        };
        assert_eq!(project_config.len(), 1);
        assert_eq!(project_config[0].relative_path, ".opencode/opencode.json");
        assert!(
            prepare(&[]).is_err(),
            "an accepted empty selection cannot rediscover a mount"
        );
        assert!(
            prepare(&[DiscoveryRoot {
                logical_path: home.join(".opencode"),
                role: DiscoveryRole::Home
            }])
            .is_err(),
            "HOME alone does not mount the workspace target"
        );
        let outside = root.path().join("outside.json");
        fs::write(&outside, "{}").unwrap();
        fs::remove_file(shared.join("opencode.json")).unwrap();
        symlink(outside, shared.join("opencode.json")).unwrap();
        assert!(
            prepare(&[selected]).is_err(),
            "a file escaping the selected directory is not mounted"
        );
    }
}
