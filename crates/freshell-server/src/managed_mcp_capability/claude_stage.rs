//! Finite Claude source roots enter the same ordinary resource graph as Codex.
use super::ordinary_stage::{prepare_selected, Preparation};
use freshell_platform::claude_inputs::{ClaudeInputManifest, ClaudeSettingSource};
use std::path::{Path, PathBuf};

pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: Option<&ClaudeInputManifest>,
    excluded: &[PathBuf],
) -> Result<Preparation, String> {
    let mut manifest = accepted.cloned().unwrap_or_else(|| ClaudeInputManifest {
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        workspace: workspace.into(),
        config_root: None,
        settings_file: None,
        settings_origin: None,
        inline_settings_sha256: None,
        setting_sources: freshell_platform::claude_inputs::default_setting_sources(),
        plugin_dirs: vec![],
    });
    manifest.validate().map_err(str::to_string)?;
    let mut configurations = Vec::new();
    let mut resources = Vec::new();
    let mut memory = Vec::new();
    if let Some(selected) = &manifest.settings_file {
        let origin = canonical(selected)?;
        if !std::fs::metadata(&origin).is_ok_and(|metadata| metadata.is_file()) {
            return Err(format!(
                "Claude --settings {} must select a regular file",
                selected.display()
            ));
        }
        manifest.settings_origin = Some(origin.clone());
        configurations.push((origin.clone(), origin));
    }
    let mut bases: Vec<PathBuf> = manifest
        .cwd
        .ancestors()
        .filter(|path| path.parent().is_some())
        .map(Path::to_path_buf)
        .collect();
    bases.sort();
    bases.dedup();
    let config_root = manifest.config_root();
    let user_settings = config_root.join("settings.json");
    let user_enabled = manifest
        .setting_sources
        .contains(&ClaudeSettingSource::User);
    let project_enabled = manifest
        .setting_sources
        .contains(&ClaudeSettingSource::Project);
    let local_enabled = manifest
        .setting_sources
        .contains(&ClaudeSettingSource::Local);
    if user_enabled && optional(&user_settings)? {
        configurations.push((user_settings.clone(), canonical(&user_settings)?));
    }
    for relative in [
        "CLAUDE.md",
        "rules",
        "skills",
        "commands",
        "agents",
        "hooks",
        "plugins",
    ] {
        if !user_enabled {
            continue;
        }
        let logical = config_root.join(relative);
        if optional(&logical)? {
            if relative == "CLAUDE.md" {
                memory.push(logical.clone());
            }
            resources.push(logical);
        }
    }
    let mut settings = Vec::new();
    if project_enabled {
        settings.push(manifest.cwd.join(".claude/settings.json"));
    }
    if local_enabled {
        settings.push(manifest.cwd.join(".claude/settings.local.json"));
        settings.push(manifest.workspace.join(".claude/settings.local.json"));
    }
    settings.sort();
    settings.dedup();
    for logical in settings {
        if optional(&logical)? {
            configurations.push((logical.clone(), canonical(&logical)?));
        }
    }
    for base in bases {
        for (enabled, relative) in [
            (project_enabled, "CLAUDE.md"),
            (local_enabled, "CLAUDE.local.md"),
            (project_enabled, ".claude/CLAUDE.md"),
            (project_enabled, ".claude/rules"),
            (project_enabled, ".claude/skills"),
            (project_enabled, ".claude/commands"),
            (project_enabled, ".claude/agents"),
            (project_enabled, ".claude/hooks"),
            (project_enabled, ".claude/plugins"),
        ] {
            if !enabled {
                continue;
            }
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

// Only append Freshell's two shipped hook groups. Native settings merging,
// source precedence and all other configured values remain the provider's job.
pub(super) fn stage_settings(
    root: &Path,
    preparation: &Preparation,
    inline_settings: Option<&str>,
) -> Result<(), String> {
    use freshell_platform::claude_inputs::{
        settings_with_owned_hooks, INLINE_SETTINGS_SOURCE, MAX_NATIVE_SETTINGS_BYTES,
    };
    use std::io::Read;
    let manifest: ClaudeInputManifest = serde_json::from_slice(preparation.manifest_bytes())
        .map_err(|_| "accepted Claude discovery metadata invalid")?;
    if let Some(digest) = &manifest.inline_settings_sha256 {
        let result: Result<(), String> = (|| {
            use sha2::{Digest, Sha256};
            let raw = inline_settings.ok_or("accepted Claude inline settings source is unavailable; retain inputs and reprepare before dispatch")?;
            if raw.len() > MAX_NATIVE_SETTINGS_BYTES {
                return Err("Claude inline --settings exceeds native 2 MiB limit".into());
            }
            if format!("{:x}", Sha256::digest(raw.as_bytes())) != *digest {
                return Err("accepted Claude inline settings source identity changed".into());
            }
            let merged = settings_with_owned_hooks(raw.as_bytes()).map_err(str::to_string)?;
            freshell_runtime_protocol::bounded_json_bytes(&merged, MAX_NATIVE_SETTINGS_BYTES)
                .map_err(|_| "combined Claude inline settings exceeds native 2 MiB limit")?;
            super::private_directory(&root.join(".freshell/source-views"))?;
            super::write_private_bytes(&root.join(INLINE_SETTINGS_SOURCE), raw.as_bytes())
        })();
        return result.inspect_err(|reason| {
            tracing::warn!(
                event = "provider.inputs.preparation.blocked",
                provider = "claude",
                stage = "controller",
                operation = "stage_inline_settings",
                reason,
                "Selected Claude inline settings could not be prepared"
            );
        });
    }
    let Some(selected) = &manifest.settings_origin else {
        return Ok(());
    };
    let destination = manifest.runtime_path(selected);
    let bind = preparation
        .binds
        .iter()
        .find(|bind| Path::new(&bind.logical_destination) == destination)
        .ok_or("Claude explicit settings source has no accepted config bind")?;
    let path = root.join(&bind.source_relative_path);
    let result: Result<(), &'static str> = (|| {
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .map_err(|_| "read selected settings")?
            .take(MAX_NATIVE_SETTINGS_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "read selected settings")?;
        let settings = settings_with_owned_hooks(&bytes)?;
        let bytes =
            freshell_runtime_protocol::bounded_json_bytes(&settings, MAX_NATIVE_SETTINGS_BYTES)
                .map_err(|_| "combined settings exceeds native 2 MiB limit")?;
        // The copier made this private, physical file in a not-yet-published
        // attempt. Writing it retains its executable bits and failed attempts
        // are removed by the existing stage transaction.
        std::fs::write(&path, bytes).map_err(|_| "write selected settings")?;
        Ok(())
    })();
    result.map_err(|reason| {
        tracing::warn!(event="provider.inputs.preparation.blocked",provider="claude",stage="controller",operation="stage_explicit_settings",path=%selected.display(),reason,
            "Selected Claude settings could not be prepared");
        format!("Claude --settings {}: {reason}", selected.display())
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_platform::{
        claude_inputs::ClaudeSettingSource,
        provider_environment::{copy_environment, CopyLimits},
    };

    #[test]
    fn managed_provider_claude_disabled_sources_do_not_traverse_or_copy_unselected_memory() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let user = home.join(".claude");
        let project = cwd.join(".claude");
        std::fs::create_dir_all(&user).unwrap();
        std::fs::create_dir_all(project.join("commands")).unwrap();
        std::fs::write(user.join("CLAUDE.md"), "@../missing-disabled-user.md").unwrap();
        std::fs::write(user.join("settings.json"), "disabled-user-settings").unwrap();
        std::fs::write(project.join("settings.json"), "selected-project-settings").unwrap();
        std::fs::write(
            project.join("commands/resource"),
            "selected-project-resource",
        )
        .unwrap();
        std::fs::write(project.join("commands/probe.mjs"), "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync(new URL('./resource',import.meta.url)))").unwrap();
        let mut manifest = ClaudeInputManifest {
            version: 1,
            original_home: home.clone(),
            cwd: cwd.clone(),
            workspace: cwd.clone(),
            config_root: Some(user.clone()),
            settings_file: None,
            settings_origin: None,
            inline_settings_sha256: None,
            setting_sources: vec![ClaudeSettingSource::Project],
            plugin_dirs: vec![],
        };
        let selected = prepare(&home, &cwd, &cwd, Some(&manifest), &[])
            .expect("disabled user memory must never become a selected import");
        let stage = owned.path().join("stage");
        copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
        let commands = selected
            .mounts
            .iter()
            .find(|mount| Path::new(&mount.logical_destination) == project.join("commands"))
            .unwrap();
        let output = std::process::Command::new("node")
            .current_dir(&cwd)
            .arg(stage.join(&commands.stage_relative_path).join("probe.mjs"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"selected-project-resource");
        assert!(!selected
            .binds
            .iter()
            .any(|bind| Path::new(&bind.logical_destination) == user.join("settings.json")));
        std::fs::write(cwd.join("CLAUDE.md"), "@missing-disabled-project.md").unwrap();
        manifest.setting_sources.clear();
        let disabled = prepare(&home, &cwd, &cwd, Some(&manifest), &[])
            .expect("an empty native selector must leave all filesystem sources unselected");
        assert!(disabled.binds.is_empty());
        assert!(disabled.mounts.is_empty());
    }
}
