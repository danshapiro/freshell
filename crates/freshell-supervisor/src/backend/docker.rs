use freshell_runtime_protocol::{FreshAgentLaunchSpec, ProviderBootstrapFile, TerminalLaunchSpec};
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
}

pub fn terminal_mounts(spec: &TerminalLaunchSpec) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
    )
}

pub fn fresh_agent_mounts(spec: &FreshAgentLaunchSpec) -> Result<TerminalMounts, String> {
    workload_mounts(
        &spec.workspace_path,
        &spec.cwd,
        spec.git_common_dir.as_deref(),
        &spec.provider_bootstrap_files,
    )
}

fn workload_mounts(
    workspace_path: &str,
    cwd_path: &str,
    git_common_path: Option<&str>,
    bootstrap_files: &[ProviderBootstrapFile],
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
    let mut provider_secret_files = Vec::with_capacity(spec.provider_secret_references.len());
    for secret in &spec.provider_secret_references {
        let source = std::fs::canonicalize(&secret.source_path)
            .map_err(|error| format!("provider secret reference: {error}"))?;
        if !source.is_file() || source != Path::new(&secret.source_path) {
            return Err("provider secret reference must be a canonical regular file".into());
        }
        reject_management_path(&source)?;
        provider_secret_files.push(source);
    }
    Ok(TerminalMounts {
        workspace,
        git_common_dir,
        provider_bootstrap_files,
        provider_secret_files,
    })
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
