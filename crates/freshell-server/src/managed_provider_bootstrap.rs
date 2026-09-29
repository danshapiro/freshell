#[cfg(unix)]
use freshell_runtime_protocol::ProviderSecretProfile;
use freshell_runtime_protocol::ProviderSecretReference;
use freshell_runtime_protocol::{
    ProviderConfigReference, ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation,
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// This is the provider-effective model configured by the approved OneCLI
/// deployment, not a synthetic model selected purely for qualification.
pub const AMPLIFIER_MODEL: &str = "glm-5.3";
pub const AMPLIFIER_REASONING_EFFORT: &str = "provider-default";
pub const AMPLIFIER_PROGRAM: &str = "/usr/local/bin/freshell-amplifier-onecli";

pub fn provider_launch_context(provider: &str, workspace: &Path) -> Option<ProviderLaunchContext> {
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
                "plugins",
                "agents",
                "commands",
                "skills",
            ][..],
            ProviderPreparation::Opencode {
                project_config: Vec::new(),
                tui_config: None,
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
                let metadata = std::fs::symlink_metadata(workspace.join(entry)).ok()?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
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
            }
        }
        other => other,
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let config = home
        .into_iter()
        .flat_map(|home| {
            entries.iter().filter_map(move |entry| {
                let path = home.join(root).join(entry);
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
                    relative_path: (*entry).into(),
                    provider_relative_path: format!("{root}/{entry}"),
                    format: format.into(),
                })
            })
        })
        .collect();
    Some(ProviderLaunchContext {
        preparation,
        mcp_capability: None,
        config,
        plugins: Vec::new(),
    })
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

#[cfg(not(unix))]
pub fn amplifier_secret_references(
    _model: Option<&str>,
    _effort: Option<&str>,
) -> Result<Vec<ProviderSecretReference>, String> {
    Err("Amplifier OneCLI bootstrap requires Unix file permissions".into())
}

#[cfg(unix)]
pub fn amplifier_secret_references(
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Vec<ProviderSecretReference>, String> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Amplifier OneCLI bootstrap requires HOME".to_string())?;
    let approved_keys = home.join(".amplifier/keys.env");
    let configured_keys = std::env::var("FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| approved_keys.clone());
    let raw_oauth = std::env::var("FRESHELL_MANAGED_AMPLIFIER_OAUTH_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let fallback = home.join(".amplifier/openai-chatgpt-oauth.json");
            fallback.is_file().then_some(fallback)
        });
    validate_amplifier_bootstrap(
        model,
        effort,
        &configured_keys,
        &approved_keys,
        raw_oauth.as_deref(),
    )
}

#[cfg(unix)]
fn validate_amplifier_bootstrap(
    model: Option<&str>,
    effort: Option<&str>,
    configured_keys: &Path,
    approved_keys: &Path,
    raw_oauth: Option<&Path>,
) -> Result<Vec<ProviderSecretReference>, String> {
    if model != Some(AMPLIFIER_MODEL) || effort != Some(AMPLIFIER_REASONING_EFFORT) {
        return Err(format!(
            "Amplifier OneCLI requires model {AMPLIFIER_MODEL} with native provider-default reasoning"
        ));
    }
    if raw_oauth.is_some() {
        return Err("Amplifier OneCLI keys.env conflicts with raw OAuth bootstrap; remove the OAuth reference for qualification".into());
    }
    let approved_metadata = std::fs::symlink_metadata(approved_keys).map_err(|error| {
        format!(
            "approved Amplifier OneCLI keys file {} is missing: {error}",
            approved_keys.display()
        )
    })?;
    if !approved_metadata.is_file()
        || approved_metadata.file_type().is_symlink()
        || approved_metadata.permissions().mode() & 0o077 != 0
    {
        return Err(
            "approved Amplifier OneCLI keys file must be a private regular file (mode 0600 or stricter), not a symlink".into(),
        );
    }
    let approved = std::fs::canonicalize(approved_keys).map_err(|error| {
        format!(
            "approved Amplifier OneCLI keys file {} is unavailable: {error}",
            approved_keys.display()
        )
    })?;
    let configured_metadata = std::fs::symlink_metadata(configured_keys).map_err(|error| {
        format!(
            "Amplifier OneCLI keys reference {} is missing: {error}",
            configured_keys.display()
        )
    })?;
    if !configured_metadata.is_file() || configured_metadata.file_type().is_symlink() {
        return Err("Amplifier OneCLI keys reference must be a regular file, not a symlink".into());
    }
    let configured = std::fs::canonicalize(configured_keys).map_err(|error| {
        format!(
            "Amplifier OneCLI keys reference {} is unavailable: {error}",
            configured_keys.display()
        )
    })?;
    if configured != approved {
        return Err(format!(
            "Amplifier OneCLI keys reference must resolve to the approved private file {}",
            approved.display()
        ));
    }
    if configured_metadata.permissions().mode() & 0o077 != 0 {
        return Err(
            "Amplifier OneCLI keys reference must be private (mode 0600 or stricter)".into(),
        );
    }
    Ok(vec![ProviderSecretReference {
        source_path: configured.to_string_lossy().into_owned(),
        profile: ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
    }])
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;

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
        let context = provider_launch_context("opencode", workspace.path()).unwrap();
        assert!(
            matches!(context.preparation, ProviderPreparation::Opencode { ref project_config, .. }
            if project_config.iter().any(|reference| reference.root == ProviderConfigRoot::Workspace
                && reference.relative_path == "opencode.json"))
        );
        context.validate("opencode").unwrap();
    }

    fn private_file(root: &Path) -> PathBuf {
        let path = root.join("keys.env");
        fs::write(&path, "LUNAROUTE_API_KEY=onecli-managed-by-proxy\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    #[test]
    fn accepts_only_the_approved_reference_and_actual_onecli_profile() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        let refs = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &keys,
            &keys,
            None,
        )
        .unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_path, keys.to_string_lossy());
        assert_eq!(
            refs[0].profile,
            ProviderSecretProfile::AmplifierOnecliLunarouteGlm53
        );
    }

    #[test]
    fn fails_closed_for_a_different_model_or_raw_oauth_without_inventing_endpoint_configuration() {
        let root = tempfile::tempdir().unwrap();
        let keys = private_file(root.path());
        for result in [
            validate_amplifier_bootstrap(
                Some("different-model"),
                Some(AMPLIFIER_REASONING_EFFORT),
                &keys,
                &keys,
                None,
            ),
            validate_amplifier_bootstrap(Some(AMPLIFIER_MODEL), Some("high"), &keys, &keys, None),
            validate_amplifier_bootstrap(
                Some(AMPLIFIER_MODEL),
                Some(AMPLIFIER_REASONING_EFFORT),
                &keys,
                &keys,
                Some(Path::new("oauth.json")),
            ),
        ] {
            assert!(result.is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_even_when_it_resolves_to_the_approved_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let approved = private_file(root.path());
        let linked = root.path().join("linked.env");
        symlink(&approved, &linked).unwrap();
        let error = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &linked,
            &approved,
            None,
        )
        .unwrap_err();
        assert!(error.contains("symlink"));
    }

    #[test]
    fn rejects_a_different_or_public_keys_file() {
        let root = tempfile::tempdir().unwrap();
        let approved = private_file(root.path());
        let other = root.path().join("other.env");
        fs::write(&other, "LUNAROUTE_API_KEY=other\n").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
        let different = validate_amplifier_bootstrap(
            Some(AMPLIFIER_MODEL),
            Some(AMPLIFIER_REASONING_EFFORT),
            &other,
            &approved,
            None,
        );
        assert!(different.unwrap_err().contains("approved private file"));
    }
}
