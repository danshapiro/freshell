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

#[derive(Clone, Copy, PartialEq, Eq)]
enum MountPurpose {
    Create,
    Adopt,
}

pub fn terminal_mounts(spec: &TerminalLaunchSpec) -> Result<TerminalMounts, String> {
    terminal_mounts_for(spec, MountPurpose::Create)
}

pub(super) fn terminal_mounts_for_adoption(
    spec: &TerminalLaunchSpec,
) -> Result<TerminalMounts, String> {
    terminal_mounts_for(spec, MountPurpose::Adopt)
}

fn terminal_mounts_for(
    spec: &TerminalLaunchSpec,
    purpose: MountPurpose,
) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
        &spec.provider_secret_references,
        spec.provider_launch_context.as_ref(),
        &spec.mode,
        purpose,
    )
}

pub fn fresh_agent_mounts(spec: &FreshAgentLaunchSpec) -> Result<TerminalMounts, String> {
    fresh_agent_mounts_for(spec, MountPurpose::Create)
}

pub(super) fn fresh_agent_mounts_for_adoption(
    spec: &FreshAgentLaunchSpec,
) -> Result<TerminalMounts, String> {
    fresh_agent_mounts_for(spec, MountPurpose::Adopt)
}

fn fresh_agent_mounts_for(
    spec: &FreshAgentLaunchSpec,
    purpose: MountPurpose,
) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
        &spec.provider_secret_references,
        spec.provider_launch_context.as_ref(),
        spec.provider.native_provider(),
        purpose,
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
    purpose: MountPurpose,
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
        if purpose == MountPurpose::Adopt {
            let source = accepted_source_path(&file.source_path)?;
            provider_bootstrap_files.push(source);
            continue;
        }
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
        if purpose == MountPurpose::Adopt {
            provider_secret_files.push(accepted_source_path(&secret.source_path)?);
            if indexed && secret.profile.is_configuration_file() {
                indexed_secret_sources.insert(index, source_id);
                source_id += 1;
            }
            continue;
        }
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
            Some(staged_provider_root_for(
                &capability_directory_for(purpose)?,
                &capability.grant_id,
                purpose,
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
            let directory = capability_directory_for(purpose)?;
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
            if purpose == MountPurpose::Adopt {
                return Ok(source);
            }
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
    let prepared = prepared_input_mounts_for(
        &workspace,
        provider_user_root.as_deref(),
        context.and_then(|context| context.prepared_inputs.as_ref()),
        purpose,
        context.and_then(|context| context.mcp_capability.as_ref()),
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

/// The ordinary subset of the workload's existing prepared mount plan. This
/// does not resolve credentials, read a capability file, or consult user HOME.
pub(super) fn ordinary_claude_candidate_mounts(
    workspace: &Path,
    git_common_dir: Option<&Path>,
    stage: &Path,
    context: &ProviderLaunchContext,
) -> Result<TerminalMounts, String> {
    context.validate("claude").map_err(|error| error.message)?;
    let inputs = context
        .prepared_inputs
        .as_ref()
        .ok_or("Claude candidate ordinary inputs unavailable")?;
    if inputs.indexed_files.is_some()
        || inputs.manifest.source_count != 0
        || inputs.manifest.alias_count != 0
        || inputs.manifest.recipe_count != 0
    {
        return Err("Claude candidate contains unavailable ordinary file selections".into());
    }
    if canonical_dir(workspace, "candidate workspace")? != workspace
        || canonical_dir(stage, "candidate stage")? != stage
    {
        return Err("Claude candidate ordinary namespace changed".into());
    }
    if let Some(common) = git_common_dir {
        if canonical_dir(common, "candidate common directory")? != common {
            return Err("Claude candidate ordinary common directory changed".into());
        }
    }
    let prepared = prepared_input_mounts(workspace, Some(stage), Some(inputs))?;
    Ok(TerminalMounts {
        workspace: workspace.into(),
        git_common_dir: git_common_dir.map(Path::to_path_buf),
        provider_bootstrap_files: vec![],
        provider_secret_files: vec![],
        indexed_secret_sources: Default::default(),
        provider_user_root: Some(stage.into()),
        mcp_capability_file: None,
        input_manifest: prepared.input_manifest,
        config_binds: prepared.config_binds,
        resource_mounts: prepared.resource_mounts,
        indexed_files: None,
    })
}

fn prepared_input_mounts(
    workspace: &Path,
    root: Option<&Path>,
    inputs: Option<&freshell_runtime_protocol::PreparedProviderInputs>,
) -> Result<PreparedInputMounts, String> {
    prepared_input_mounts_for(workspace, root, inputs, MountPurpose::Create, None)
}

fn prepared_input_mounts_for(
    workspace: &Path,
    root: Option<&Path>,
    inputs: Option<&freshell_runtime_protocol::PreparedProviderInputs>,
    purpose: MountPurpose,
    capability: Option<&freshell_runtime_protocol::McpCapabilityReference>,
) -> Result<PreparedInputMounts, String> {
    let mut prepared = PreparedInputMounts::default();
    if let Some(inputs) = inputs {
        let root = root.ok_or("prepared provider stage is unavailable")?;
        if purpose == MountPurpose::Adopt {
            inputs.validate(capability).map_err(|error| error.message)?;
            // Existing mounts are verified against these accepted descriptors
            // and Docker's actual immutable configuration below. Missing or
            // changed source bytes cannot authorize a new launch, but do not
            // change the identity of an already mounted, healthy workload.
            return Ok(PreparedInputMounts {
                input_manifest: Some(root.join(&inputs.manifest.relative_path)),
                config_binds: inputs
                    .config_binds
                    .iter()
                    .map(|reference| ResolvedProviderConfigBind {
                        source: root.join(&reference.source_relative_path),
                        reference: reference.clone(),
                    })
                    .collect(),
                resource_mounts: inputs.resource_mounts.clone(),
                indexed_files: inputs.indexed_files.clone(),
            });
        }
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

    #[test]
    fn provider_prepared_adoption_keeps_accepted_routes_when_source_authority_is_lost() {
        let (owned, stage, workspace, mut inputs) = fixture();
        let capability = freshell_runtime_protocol::McpCapabilityReference {
            grant_id: inputs.generation_id.clone(),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let expected = prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).unwrap();
        std::fs::rename(&stage, owned.path().join("unavailable-stage")).unwrap();
        let adopted = prepared_input_mounts_for(
            &workspace,
            Some(&stage),
            Some(&inputs),
            MountPurpose::Adopt,
            Some(&capability),
        )
        .expect("accepted mounted descriptors do not require source republication");
        assert_eq!(adopted.input_manifest, expected.input_manifest);
        assert_eq!(adopted.config_binds, expected.config_binds);
        assert_eq!(adopted.resource_mounts, expected.resource_mounts);
        assert!(
            prepared_input_mounts(&workspace, Some(&stage), Some(&inputs)).is_err(),
            "missing authority must still block creating a new runtime"
        );
        inputs.config_binds[0].source_relative_path = "../unapproved".into();
        assert!(prepared_input_mounts_for(
            &workspace,
            Some(&stage),
            Some(&inputs),
            MountPurpose::Adopt,
            Some(&capability)
        )
        .is_err());
        assert_eq!(
            std::fs::read(
                owned
                    .path()
                    .join("unavailable-stage/.freshell/templates/source-0")
            )
            .unwrap(),
            b"{\"model\":\"transported\"}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_prepared_adoption_terminal_and_fresh_use_the_same_accepted_mounts() {
        const CHILD: &str = "FRESHELL_ADOPTION_MOUNT_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new("/usr/bin/timeout")
                .args(["--kill-after=1s", "20s"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", "backend::docker::prepared_stage_tests::provider_prepared_adoption_terminal_and_fresh_use_the_same_accepted_mounts", "--nocapture"])
                .env(CHILD, "1").status().unwrap();
            assert!(status.success(), "isolated shared adoption behavior failed");
            return;
        }
        let (owned, stage, workspace, inputs) = fixture();
        let capabilities = owned.path().join("mcp-capabilities");
        let selected = owned
            .path()
            .join("provider-roots")
            .join(&inputs.generation_id);
        std::fs::create_dir(&capabilities).unwrap();
        std::fs::create_dir(selected.parent().unwrap()).unwrap();
        std::fs::rename(stage, &selected).unwrap();
        let capability = freshell_runtime_protocol::McpCapabilityReference {
            grant_id: inputs.generation_id.clone(),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let grant = capabilities.join(format!("{}.json", capability.grant_id));
        std::fs::write(&grant, b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&grant, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        std::env::set_var("FRESHELL_RUNTIME_CAPABILITY_DIR", &capabilities);
        let context = ProviderLaunchContext {
            preparation: freshell_runtime_protocol::ProviderPreparation::Claude {
                mcp_args: vec![],
            },
            config: vec![],
            mcp_capability: Some(capability),
            prepared_inputs: Some(inputs),
        };
        let mut terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"adoption-terminal", "streamId":"stream", "mode":"claude", "program":"claude", "args":[],
            "cwd":workspace,"workspacePath":workspace,"projectKey":"project", "runAsUid":65534,"runAsGid":0,"cols":80,"rows":24
        })).unwrap();
        terminal.provider_launch_context = Some(context.clone());
        let mut fresh: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
            "sessionId":"adoption-fresh", "provider":"claude", "sessionType":"freshclaude", "runtimeVariant":"claude-sdk",
            "providerStoreId":"store", "cwd":workspace,"workspacePath":workspace,"runAsUid":65534,"runAsGid":0
        })).unwrap();
        fresh.provider_launch_context = Some(context);
        let expected = terminal_mounts(&terminal).unwrap();
        assert_eq!(fresh_agent_mounts(&fresh).unwrap(), expected);
        std::fs::rename(&selected, owned.path().join("unavailable-selected")).unwrap();
        std::fs::rename(&grant, grant.with_extension("unavailable")).unwrap();
        assert_eq!(terminal_mounts_for_adoption(&terminal).unwrap(), expected);
        assert_eq!(fresh_agent_mounts_for_adoption(&fresh).unwrap(), expected);
        assert!(terminal_mounts(&terminal).is_err());
        assert!(fresh_agent_mounts(&fresh).is_err());
    }
}

fn capability_directory() -> Result<PathBuf, String> {
    capability_directory_for(MountPurpose::Create)
}

fn capability_directory_for(purpose: MountPurpose) -> Result<PathBuf, String> {
    let directory = CAPABILITY_DIR
        .get()
        .cloned()
        .or_else(|| std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").map(PathBuf::from))
        .ok_or("managed MCP capability directory is unavailable")?;
    if purpose == MountPurpose::Adopt {
        return accepted_source_path(
            directory
                .to_str()
                .ok_or("managed capability path is not UTF-8")?,
        );
    }
    std::fs::canonicalize(&directory)
        .map_err(|error| format!("managed MCP capability directory unavailable: {error}"))
}

pub(crate) fn staged_provider_root_for_grant(grant_id: &str) -> Result<PathBuf, String> {
    approved_staged_provider_root(&capability_directory()?, grant_id)
}

fn approved_staged_provider_root(directory: &Path, grant_id: &str) -> Result<PathBuf, String> {
    staged_provider_root_for(directory, grant_id, MountPurpose::Create)
}

fn staged_provider_root_for(
    directory: &Path,
    grant_id: &str,
    purpose: MountPurpose,
) -> Result<PathBuf, String> {
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
    if purpose == MountPurpose::Adopt {
        return Ok(expected);
    }
    let canonical = canonical_dir(&expected, "managed provider root")?;
    if canonical != expected {
        return Err("managed provider root must be canonical".into());
    }
    Ok(canonical)
}

fn accepted_source_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err("accepted mount source must be an absolute normal path".into());
    }
    reject_management_path(path)?;
    Ok(path.into())
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
