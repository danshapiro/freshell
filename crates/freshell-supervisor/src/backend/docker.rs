use freshell_runtime_protocol::TerminalLaunchSpec;
use std::path::{Path, PathBuf};

/// Exact extra-mount set for a Phase 2 terminal workload. Every source is
/// canonicalized before Docker sees it; destinations preserve the host's
/// absolute workspace/git paths so Git worktrees keep their common-dir links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalMounts {
    pub workspace: PathBuf,
    pub git_common_dir: Option<PathBuf>,
}

pub fn terminal_mounts(spec: &TerminalLaunchSpec) -> Result<TerminalMounts, String> {
    let workspace = canonical_dir(Path::new(&spec.workspace_path), "workspace")?;
    if workspace != PathBuf::from(&spec.workspace_path) {
        return Err("workspace path must already be canonical".into());
    }
    let cwd = canonical_dir(Path::new(&spec.cwd), "cwd")?;
    if cwd != PathBuf::from(&spec.cwd) {
        return Err("cwd path must already be canonical".into());
    }
    if !cwd.starts_with(&workspace) {
        return Err("terminal cwd must be inside the approved workspace".into());
    }
    reject_management_path(&workspace)?;
    let git_common_dir = spec
        .git_common_dir
        .as_deref()
        .map(|raw| -> Result<PathBuf, String> {
            let canonical = canonical_dir(Path::new(raw), "git common dir")?;
            if canonical != PathBuf::from(raw) {
                return Err("git common dir must already be canonical".into());
            }
            Ok(canonical)
        })
        .transpose()?;
    if let Some(git) = &git_common_dir {
        reject_management_path(git)?;
    }
    Ok(TerminalMounts {
        workspace,
        git_common_dir,
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
