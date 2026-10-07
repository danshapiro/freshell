//! Finite Claude source roots enter the same ordinary resource graph as Codex.
use super::ordinary_stage::{prepare_selected, Preparation};
use freshell_platform::claude_inputs::ClaudeInputManifest;
use std::path::{Path, PathBuf};

pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: Option<&ClaudeInputManifest>,
    excluded: &[PathBuf],
) -> Result<Preparation, String> {
    let manifest = accepted.cloned().unwrap_or_else(|| ClaudeInputManifest {
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        workspace: workspace.into(),
        plugin_dirs: vec![],
    });
    manifest.validate().map_err(str::to_string)?;
    let mut configurations = Vec::new();
    let mut resources = Vec::new();
    let mut memory = Vec::new();
    let mut bases: Vec<PathBuf> = manifest.cwd.ancestors().map(Path::to_path_buf).collect();
    bases.push(manifest.original_home.clone());
    bases.sort();
    bases.dedup();
    let mut settings_bases = vec![
        manifest.original_home.clone(),
        manifest.cwd.clone(),
        manifest.workspace.clone(),
    ];
    settings_bases.sort();
    settings_bases.dedup();
    for base in settings_bases {
        for name in ["settings.json", "settings.local.json"] {
            let logical = base.join(".claude").join(name);
            if optional(&logical)? {
                configurations.push((logical.clone(), canonical(&logical)?));
            }
        }
    }
    for base in bases {
        for relative in [
            "CLAUDE.md",
            "CLAUDE.local.md",
            ".claude/CLAUDE.md",
            ".claude/rules",
            ".claude/skills",
            ".claude/commands",
            ".claude/agents",
            ".claude/hooks",
            ".claude/plugins",
        ] {
            let logical = base.join(relative);
            if optional(&logical)? {
                if matches!(
                    relative,
                    "CLAUDE.md" | "CLAUDE.local.md" | ".claude/CLAUDE.md"
                ) {
                    memory.push(logical.clone());
                }
                resources.push(logical);
            }
        }
    }
    for plugin in &manifest.plugin_dirs {
        canonical(plugin)?; // Explicit selections may never be silently omitted.
        resources.push(plugin.clone());
    }
    for imported in super::claude_memory::imports(&manifest.original_home, &memory, excluded).inspect_err(|error| {
        tracing::warn!(event="provider.inputs.preparation.blocked",provider="claude",stage="controller",operation="select_memory_imports",reason=%error,"Selected Claude memory imports could not be prepared");
    })? {
        if !resources.iter().any(|root| imported.starts_with(root)) {
            resources.push(imported);
        }
    }
    prepare_selected(
        "claude",
        &manifest.cwd,
        &manifest,
        configurations,
        resources,
        |path| manifest.runtime_path(path),
    )
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|error| {
        format!(
            "Claude selected source {} is unavailable: {error}",
            path.display()
        )
    })
}
fn optional(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Claude optional source {} metadata failed: {error}",
            path.display()
        )),
    }
}
