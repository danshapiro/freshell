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
    pub indexed_secret_sources: std::collections::BTreeMap<usize, u16>,
    pub provider_user_root: Option<PathBuf>,
    pub mcp_capability_file: Option<PathBuf>,
    pub input_manifest: Option<PathBuf>,
    pub config_binds: Vec<ResolvedProviderConfigBind>,
    pub resource_mounts: Vec<freshell_runtime_protocol::ProviderResourceMount>,
    pub indexed_files: Option<freshell_runtime_protocol::IndexedProviderFiles>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProviderConfigBind {
    pub source: PathBuf,
    pub reference: freshell_runtime_protocol::ProviderConfigBind,
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
        spec.provider.native_provider(),
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
    if let Some(context) = context {
        context.validate(provider).map_err(|error| error.message)?;
    }
    freshell_runtime_protocol::validate_provider_secrets(provider, secret_references)
        .map_err(|error| error.message)?;
    if let Some(inputs) = context.and_then(|context| context.prepared_inputs.as_ref()) {
        inputs
            .validate_references(secret_references)
            .map_err(|error| error.message)?;
    }
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
    let mut indexed_secret_sources = std::collections::BTreeMap::new();
    let indexed = context
        .and_then(|context| context.prepared_inputs.as_ref())
        .is_some_and(|inputs| inputs.indexed_files.is_some());
    let mut source_id = 0u16;
    for (index, secret) in secret_references.iter().enumerate() {
        let source = std::fs::canonicalize(&secret.source_path)
            .map_err(|error| format!("provider secret reference: {error}"))?;
        if !source.is_file() || source != Path::new(&secret.source_path) {
            return Err("provider secret reference must be a canonical regular file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if !secret.profile.is_configuration_file()
                && std::fs::metadata(&source)
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
        if indexed && secret.profile.is_configuration_file() {
            indexed_secret_sources.insert(index, source_id);
            source_id += 1;
        }
    }
    let provider_user_root =
        if let Some(capability) = context.and_then(|context| context.mcp_capability.as_ref()) {
            Some(approved_staged_provider_root(
                &capability_directory()?,
                &capability.grant_id,
            )?)
        } else if context.is_some() {
            let home = std::env::var_os("HOME");
            let user_root_exists = home.as_ref().is_some_and(|home| {
                provider_user_root_path(Path::new(home), provider).is_some_and(|path| path.exists())
            });
            if let Some(home) = home.as_ref().filter(|_| user_root_exists) {
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
    let prepared = prepared_input_mounts(
        &workspace,
        provider_user_root.as_deref(),
        context.and_then(|context| context.prepared_inputs.as_ref()),
    )?;
    Ok(TerminalMounts {
        workspace,
        git_common_dir,
        provider_bootstrap_files,
        provider_secret_files,
        indexed_secret_sources,
        provider_user_root,
        mcp_capability_file,
        input_manifest: prepared.input_manifest,
        config_binds: prepared.config_binds,
        resource_mounts: prepared.resource_mounts,
        indexed_files: prepared.indexed_files,
    })
}

#[derive(Default)]
struct PreparedInputMounts {
    input_manifest: Option<PathBuf>,
    config_binds: Vec<ResolvedProviderConfigBind>,
    resource_mounts: Vec<freshell_runtime_protocol::ProviderResourceMount>,
    indexed_files: Option<freshell_runtime_protocol::IndexedProviderFiles>,
}

fn prepared_input_mounts(
    workspace: &Path,
    root: Option<&Path>,
    inputs: Option<&freshell_runtime_protocol::PreparedProviderInputs>,
) -> Result<PreparedInputMounts, String> {
    let mut prepared = PreparedInputMounts::default();
    if let Some(inputs) = inputs {
        let root = root.ok_or("prepared provider stage is unavailable")?;
        let manifest = canonical_stage_file(root, &inputs.manifest.relative_path)?;
        verify_input_manifest_digest(&manifest, &inputs.manifest.sha256)?;
        for reference in &inputs.config_binds {
            let source = canonical_stage_file(root, &reference.source_relative_path)?;
            verify_template_limit(&source)?;
            verify_workspace_destination(
                workspace,
                &reference.logical_destination,
                &reference.effective_destination,
                false,
            )?;
            prepared.config_binds.push(ResolvedProviderConfigBind {
                source,
                reference: reference.clone(),
            });
        }
        for reference in &inputs.resource_mounts {
            let source = root.join(&reference.stage_relative_path);
            let canonical = std::fs::canonicalize(&source)
                .map_err(|_| "selected prepared resource is unavailable")?;
            let metadata = std::fs::symlink_metadata(&source)
                .map_err(|_| "selected prepared resource metadata failed")?;
            let directory =
                reference.kind == freshell_runtime_protocol::ProviderResourceKind::Directory;
            if canonical != source
                || metadata.file_type().is_symlink()
                || if directory {
                    !metadata.is_dir()
                } else {
                    !metadata.is_file()
                }
            {
                return Err("prepared resource is not a physical staged unit".into());
            }
            verify_workspace_destination(
                workspace,
                &reference.logical_destination,
                &reference.effective_destination,
                directory,
            )?;
            prepared.resource_mounts.push(reference.clone());
        }
        if let Some(files) = &inputs.indexed_files {
            for alias in &files.aliases {
                verify_workspace_destination(
                    workspace,
                    &alias.logical_destination,
                    &alias.effective_destination,
                    false,
                )?;
            }
            prepared.indexed_files = Some(files.clone());
        }
        prepared.input_manifest = Some(manifest);
    }
    Ok(prepared)
}

fn canonical_stage_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = root.join(relative);
    let canonical =
        std::fs::canonicalize(&path).map_err(|_| "prepared input file is unavailable")?;
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| "prepared input file metadata failed")?;
    if canonical != path || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("prepared input file must be physical and stage-owned".into());
    }
    Ok(canonical)
}
fn verify_template_limit(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut reader = std::fs::File::open(path)
        .map_err(|_| "prepared config template is unavailable")?
        .take(16 * 1024 * 1024 + 1);
    let mut bytes = 0u64;
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|_| "prepared config template read failed")?;
        if count == 0 {
            return Ok(());
        }
        bytes += count as u64;
        if bytes > 16 * 1024 * 1024 {
            return Err("prepared config template exceeds source-view limit".into());
        }
    }
}
fn verify_input_manifest_digest(path: &Path, expected: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut reader = std::fs::File::open(path)
        .map_err(|_| "prepared input manifest is unavailable")?
        .take(64 * 1024 * 1024 + 1);
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut chunk = [0; 64 * 1024];
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|_| "prepared input manifest read failed")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > 64 * 1024 * 1024 {
            return Err("prepared input manifest exceeds stored metadata limit".into());
        }
        hash.update(&chunk[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected.to_ascii_lowercase() {
        return Err("prepared input manifest changed; reprepare before mount construction".into());
    }
    Ok(())
}
fn verify_workspace_destination(
    workspace: &Path,
    logical: &str,
    effective: &str,
    directory: bool,
) -> Result<(), String> {
    let logical = Path::new(logical);
    if !logical.starts_with(workspace) {
        return Ok(());
    }
    // These mountpoints and parents must already exist. This operation never
    // creates, chmods or edits the original workspace or its links.
    let canonical = std::fs::canonicalize(logical)
        .map_err(|_| "selected workspace input mountpoint is unavailable")?;
    let metadata = std::fs::metadata(logical)
        .map_err(|_| "selected workspace input mountpoint metadata failed")?;
    if canonical != Path::new(effective)
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err("selected workspace input topology changed; reprepare before launch".into());
    }
    Ok(())
}

#[cfg(test)]
mod prepared_stage_tests {
    use super::*;
    use freshell_runtime_protocol::{
        PreparedProviderInputs, ProviderConfigBind, ProviderInputManifestReference,
    };
    use sha2::{Digest, Sha256};

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PreparedProviderInputs) {
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("stage");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(stage.join(".freshell/templates")).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let manifest = b"{\"sources\":[]}";
        std::fs::write(stage.join(".freshell/input-manifest.json"), manifest).unwrap();
        std::fs::write(
            stage.join(".freshell/templates/source-0"),
            b"{\"model\":\"transported\"}",
        )
        .unwrap();
        let target = workspace.join("opencode.json");
        std::fs::write(&target, b"{\"model\":\"original\"}").unwrap();
        let inputs = PreparedProviderInputs {
            generation_id: "grant-prepared-stage".into(),
            initial_auth_reservation: None,
            manifest: ProviderInputManifestReference {
                relative_path: ".freshell/input-manifest.json".into(),
                sha256: format!("{:x}", Sha256::digest(manifest)),
                source_count: 0,
                alias_count: 0,
                recipe_count: 0,
            },
            config_binds: vec![ProviderConfigBind {
                source_relative_path: ".freshell/templates/source-0".into(),
                logical_destination: target.to_string_lossy().into_owned(),
                effective_destination: target.to_string_lossy().into_owned(),
            }],
            resource_mounts: vec![],
            indexed_files: None,
        };
        (root, stage, workspace, inputs)
    }

    #[test]
    fn provider_prepared_stage_bounds_actual_config_template() {
        let (_owned, stage, workspace, inputs) = fixture();
        std::fs::OpenOptions::new()
            .write(true)
            .open(stage.join(".freshell/templates/source-0"))
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert!(
            prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).is_err(),
            "oversized selected template must be rejected before mount construction"
        );
    }

    #[test]
    fn provider_prepared_stage_consumes_template_and_preserves_workspace_topology() {
        let (_owned, stage, workspace, mut inputs) = fixture();
        let original = workspace.join("opencode.json");
        let logical = workspace.join("linked.json");
        std::os::unix::fs::symlink("opencode.json", &logical).unwrap();
        inputs.config_binds[0].logical_destination = logical.to_string_lossy().into_owned();
        let mounts = prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).unwrap();
        assert_eq!(
            std::fs::read(&mounts.config_binds[0].source).unwrap(),
            b"{\"model\":\"transported\"}"
        );
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"{\"model\":\"original\"}"
        );
        assert_eq!(
            std::fs::read_link(&logical).unwrap(),
            Path::new("opencode.json")
        );
        inputs.config_binds[0].logical_destination = workspace
            .join("missing/selected.json")
            .to_string_lossy()
            .into_owned();
        assert!(prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).is_err());
        assert!(!workspace.join("missing").exists());
    }

    #[test]
    fn provider_prepared_stage_rejects_changed_manifest_and_escaped_template() {
        let (_owned, stage, workspace, inputs) = fixture();
        std::fs::write(
            stage.join(".freshell/input-manifest.json"),
            b"{\"sources\":[1]}",
        )
        .unwrap();
        assert!(prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).is_err());
        std::fs::write(
            stage.join(".freshell/input-manifest.json"),
            b"{\"sources\":[]}",
        )
        .unwrap();
        let template = stage.join(".freshell/templates/source-0");
        std::fs::remove_file(&template).unwrap();
        std::os::unix::fs::symlink(workspace.join("opencode.json"), &template).unwrap();
        assert!(prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).is_err());
        assert_eq!(
            std::fs::read(workspace.join("opencode.json")).unwrap(),
            b"{\"model\":\"original\"}"
        );
    }
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
    let canonical_home = canonical_dir(home, "HOME")?;
    let (candidate, boundary) = match provider {
        "claude" => (canonical_home.join(".claude"), canonical_home.clone()),
        "codex" => (canonical_home.join(".codex"), canonical_home.clone()),
        "amplifier" => (canonical_home.join(".amplifier"), canonical_home.clone()),
        "opencode" => {
            let config_home = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| canonical_home.join(".config"));
            let canonical_config_home = canonical_dir(&config_home, "XDG_CONFIG_HOME")?;
            (
                canonical_config_home.join("opencode"),
                canonical_config_home,
            )
        }
        _ => return Err("unapproved provider user root".into()),
    };
    let root = canonical_dir(&candidate, "provider user root")?;
    if !root.starts_with(&boundary) {
        return Err("provider user root escaped its approved source root".into());
    }
    reject_management_path(&root)?;
    Ok(root)
}

fn provider_user_root_path(home: &Path, provider: &str) -> Option<PathBuf> {
    match provider {
        "claude" => Some(home.join(".claude")),
        "codex" => Some(home.join(".codex")),
        "opencode" => Some(
            std::env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode"),
        ),
        "amplifier" => Some(home.join(".amplifier")),
        _ => None,
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
            prepared_inputs: None,
            preparation: ProviderPreparation::Opencode {
                project_config: vec![ProviderConfigReference {
                    root: ProviderConfigRoot::UserProvider,
                    relative_path: "opencode.json".into(),
                    provider_relative_path: ".config/opencode/opencode.json".into(),
                    format: "json".into(),
                }],
                tui_config: None,
                tui_source: None,
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
            provider_relative_path: None,
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
