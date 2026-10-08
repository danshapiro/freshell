//! Finite Claude source roots enter the same ordinary resource graph as Codex.
use super::ordinary_stage::{prepare_selected, Preparation};
use freshell_platform::claude_inputs::{
    observation::NativeObservation, ClaudeInputManifest, ClaudeSettingSource,
};
use std::path::{Path, PathBuf};

const RESOURCE_DIRECTORIES: &[&str] = &[
    "skills",
    "commands",
    "agents",
    "hooks",
    "plugins",
    "output-styles",
    "workflows",
    "routines",
];

pub(super) fn prepare_with_native_observation(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: &ClaudeInputManifest,
    observation: &NativeObservation,
    excluded: &[PathBuf],
) -> Result<Preparation, String> {
    observation.validate()?;
    if Some(observation.native_source_runtime) != accepted.native_source_runtime
        || observation.setting_sources != accepted.setting_sources
        || std::fs::canonicalize(cwd).ok().as_ref() != Some(&observation.cwd)
    {
        return Err("Claude native source observation does not match the selected launch; retain inputs and reprepare".into());
    }
    prepare_selected_sources(
        home,
        cwd,
        workspace,
        Some(accepted),
        Some(observation),
        excluded,
    )
}

pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: Option<&ClaudeInputManifest>,
    excluded: &[PathBuf],
) -> Result<Preparation, String> {
    prepare_selected_sources(home, cwd, workspace, accepted, None, excluded)
}

fn prepare_selected_sources(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: Option<&ClaudeInputManifest>,
    observation: Option<&NativeObservation>,
    excluded: &[PathBuf],
) -> Result<Preparation, String> {
    let mut manifest = accepted.cloned().unwrap_or_else(|| ClaudeInputManifest {
        version: 1,
        accepted_native_plan: None,
        native_source_runtime: Some(
            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
        ),
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
    let mut user_rules = Vec::new();
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
    let native_cwd = observation
        .map(|observed| observed.cwd.clone())
        .unwrap_or_else(|| {
            std::fs::canonicalize(&manifest.cwd).unwrap_or_else(|_| manifest.cwd.clone())
        });
    let mut bases: Vec<PathBuf> = native_cwd
        .ancestors()
        .filter(|path| path.parent().is_some())
        .map(Path::to_path_buf)
        .collect();
    bases.reverse();
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
    let roots = if let Some(observed) = observation {
        observed.roots.clone()
    } else if project_enabled {
        freshell_platform::claude_inputs::git::roots(
            &native_cwd,
            manifest
                .native_source_runtime
                .ok_or("Claude native source runtime is unrecorded")?,
        )
        .inspect_err(|reason| {
            tracing::warn!(
                event = "provider.inputs.preparation.blocked",
                provider = "claude",
                stage = "controller",
                operation = "select_native_git_roots",
                reason,
                "Claude native Git source selection could not be prepared"
            );
        })?
    } else {
        None
    };
    if user_enabled && optional(&user_settings)? {
        configurations.push((user_settings.clone(), canonical(&user_settings)?));
    }
    for relative in ["CLAUDE.md", "rules"]
        .into_iter()
        .chain(RESOURCE_DIRECTORIES.iter().copied())
    {
        if !user_enabled {
            continue;
        }
        let logical = config_root.join(relative);
        if optional(&logical)? {
            if relative == "CLAUDE.md" {
                memory.push(logical.clone());
            } else if relative == "rules" {
                user_rules.push(logical.clone());
            }
            resources.push(logical);
        }
    }
    let mut settings = Vec::new();
    if project_enabled {
        settings.push(native_cwd.join(".claude/settings.json"));
    }
    if local_enabled {
        if let Some(observed) = observation {
            settings.extend(observed.local_settings.iter().cloned());
        } else {
            settings.push(manifest.cwd.join(".claude/settings.local.json"));
            settings.push(manifest.workspace.join(".claude/settings.local.json"));
        }
    }
    if observation.is_none() {
        settings.sort();
        settings.dedup();
    }
    for logical in settings {
        if optional(&logical)? {
            configurations.push((logical.clone(), canonical(&logical)?));
        }
    }
    for base in bases {
        let excluded_project = roots.as_ref().is_some_and(|roots| {
            use freshell_platform::claude_inputs::git::contained;
            roots.checkout != roots.canonical
                && contained(&roots.checkout, &roots.canonical)
                && contained(&base, &roots.canonical)
                && !contained(&base, &roots.checkout)
        });
        for (enabled, relative) in [
            (project_enabled && !excluded_project, "CLAUDE.md"),
            (local_enabled, "CLAUDE.local.md"),
            (project_enabled && !excluded_project, ".claude/CLAUDE.md"),
            (project_enabled && !excluded_project, ".claude/rules"),
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
    if project_enabled {
        for relative in RESOURCE_DIRECTORIES {
            let directories = if matches!(*relative, "hooks" | "plugins") {
                project_resource_bases(&manifest)?
                    .iter()
                    .map(|base| base.join(".claude").join(relative))
                    .filter_map(|path| match optional(&path) {
                        Ok(true) => Some(Ok(path)),
                        Ok(false) => None,
                        Err(error) => Some(Err(error)),
                    })
                    .collect::<Result<Vec<_>, String>>()?
            } else {
                project_resource_directories(&native_cwd, roots.as_ref(), relative).inspect_err(
                    |reason| {
                        tracing::warn!(
                            event = "provider.inputs.preparation.blocked",
                            provider = "claude",
                            stage = "controller",
                            operation = "select_project_resources",
                            directory = *relative,
                            reason,
                            "Selected Claude project resources could not be prepared"
                        );
                    },
                )?
            };
            resources.extend(directories);
        }
    }
    for plugin in &manifest.plugin_dirs {
        canonical(plugin)?; // Explicit selections may never be silently omitted.
        resources.push(plugin.clone());
    }
    for imported in super::claude_memory::imports(&manifest.original_home, &memory, &user_rules, excluded).inspect_err(|error| {
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

// The ordinary native initializer sets projectRoot to realpath(launch cwd).
// The Markdown loader chooses fallback independently for each category;
// requested workspace is not another source root.
fn project_resource_directories(
    cwd: &Path,
    roots: Option<&freshell_platform::claude_inputs::git::Roots>,
    relative: &str,
) -> Result<Vec<PathBuf>, String> {
    use freshell_platform::claude_inputs::git;
    let mut directories = Vec::new();
    for base in cwd.ancestors() {
        if git::lexical(base) == Path::new("/home/freshell/provider") {
            break;
        }
        let directory = base.join(".claude").join(relative);
        if native_resource_exists(&directory)? {
            directories.push(directory);
        }
        if roots.is_some_and(|roots| roots.checkout == base) {
            break;
        }
    }
    if let Some(roots) = roots {
        if roots.checkout != roots.canonical {
            let checkout = roots.checkout.join(".claude").join(relative);
            if !directories.contains(&checkout) {
                let fallback = roots.canonical.join(".claude").join(relative);
                if !directories.contains(&fallback) && native_resource_exists(&fallback)? {
                    directories.push(fallback);
                }
            }
        }
    }
    Ok(directories)
}
fn native_resource_exists(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        #[cfg(unix)]
        Err(error) if error.raw_os_error() == Some(libc::ENFILE) => {
            tracing::warn!(event="provider.inputs.resource_scan.skipped",provider="claude",stage="controller",operation="stat_project_directory",path=%path.display(),cause=%error,"Native Claude resource directory scan exhausted the file table");
            Ok(false)
        }
        Err(error) => Err(format!(
            "Claude project resource discovery {} metadata failed: {error}",
            path.display()
        )),
    }
}

// The native Markdown resource loader searches upward only until HOME or the
// nearest Git root. Memory has its own root-to-cwd search and must not share
// this stopping rule. Startup cwd is the same accepted cwd for these loaders.
fn project_resource_bases(manifest: &ClaudeInputManifest) -> Result<Vec<PathBuf>, String> {
    let mut bases = Vec::new();
    for base in manifest.cwd.ancestors() {
        if base == manifest.original_home {
            break;
        }
        bases.push(base.to_path_buf());
        match std::fs::metadata(base.join(".git")) {
            Ok(metadata) if metadata.is_dir() || metadata.is_file() => break,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => {
                return Err(format!(
                    "Claude project resource discovery {} metadata failed: {error}",
                    base.display()
                ));
            }
        }
    }
    Ok(bases)
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

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_observed_local_order_consumes_cwd_then_canonical_and_leaves_workspace_poison(
    ) {
        use freshell_platform::claude_inputs::{observation::observe, NativeSourceRuntime};
        for runtime in [NativeSourceRuntime::Terminal, NativeSourceRuntime::Sdk] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let canonical_root = owned.path().join("canonical");
            let workspace = owned.path().join("checkout");
            let cwd = workspace.join("nested");
            let gitdir = canonical_root.join(".git/worktrees/fixture");
            for path in [
                &home,
                &gitdir,
                &cwd.join(".claude"),
                &workspace.join(".claude"),
                &canonical_root.join(".claude"),
            ] {
                std::fs::create_dir_all(path).unwrap();
            }
            std::fs::write(
                workspace.join(".git"),
                format!("gitdir: {}\n", gitdir.display()),
            )
            .unwrap();
            std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
            std::fs::write(
                gitdir.join("gitdir"),
                format!("{}\n", workspace.join(".git").display()),
            )
            .unwrap();
            let current = cwd.join(".claude/settings.local.json");
            let canonical = canonical_root.join(".claude/settings.local.json");
            let unselected = workspace.join(".claude/settings.local.json");
            std::fs::write(
                &current,
                br#"{"env":{"SELECTED":"cwd","CWD_ONLY":"retained"}}"#,
            )
            .unwrap();
            std::fs::write(&canonical, br#"{"env":{"SELECTED":"canonical"}}"#).unwrap();
            let poison = b"NATIVE_UNSELECTED_WORKSPACE_POISON: invalid JSON";
            std::fs::write(&unselected, poison).unwrap();
            let manifest = ClaudeInputManifest {
                version: 1,
                accepted_native_plan: None,
                native_source_runtime: Some(runtime),
                original_home: home.clone(),
                cwd: cwd.clone(),
                workspace: workspace.clone(),
                config_root: None,
                settings_file: None,
                settings_origin: None,
                inline_settings_sha256: None,
                setting_sources: vec![ClaudeSettingSource::Local],
                plugin_dirs: vec![],
            };
            let observed = observe(&cwd, &home, runtime, &manifest.setting_sources).unwrap();
            assert_eq!(observed.uid, unsafe { libc::getuid() });
            assert_eq!(observed.local_settings, [current, canonical]);
            let selected=prepare_with_native_observation(&home,&cwd,&workspace,&manifest,&observed,&[])
                .expect("native-selected local settings must prepare without the unrelated workspace document");
            let stage = owned.path().join("stage");
            copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
            stage_settings(&stage, &selected, None)
                .expect("unselected malformed workspace settings must not be read or staged");
            let files = selected
                .binds
                .iter()
                .map(|bind| stage.join(&bind.source_relative_path))
                .collect::<Vec<_>>();
            let output=std::process::Command::new("node").args(["-e", "const fs=require('node:fs');let env={};for(const file of process.argv.slice(1)){Object.assign(env,JSON.parse(fs.readFileSync(file,'utf8')).env||{})};process.stdout.write(env.SELECTED+':'+env.CWD_ONLY)"])
                .args(files).output().unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, b"canonical:retained");
            assert!(std::fs::read(&unselected).unwrap() == poison);
            assert!(!selected
                .selections
                .iter()
                .any(|copy| copy.source == unselected));
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_project_resources_stop_at_git_and_home_without_losing_memory() {
        for git_boundary in [true, false] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let boundary = if git_boundary {
                home.join("project")
            } else {
                home.clone()
            };
            let cwd = boundary.join("nested");
            let commands = cwd.join(".claude/commands");
            std::fs::create_dir_all(commands.join("node_modules/probe-dependency")).unwrap();
            if git_boundary {
                std::fs::create_dir(boundary.join(".git")).unwrap();
            }
            let unselected = if git_boundary {
                home.clone()
            } else {
                boundary.clone()
            };
            std::fs::create_dir_all(unselected.join(".claude")).unwrap();
            std::os::unix::fs::symlink(
                "missing-unselected-commands",
                unselected.join(".claude/commands"),
            )
            .unwrap();
            std::fs::write(commands.join("resource"), "selected-command-resource").unwrap();
            std::fs::write(
                commands.join("node_modules/probe-dependency/index.js"),
                "module.exports='selected-installed-dependency'",
            )
            .unwrap();
            std::fs::write(commands.join("run.cjs"), "process.stdout.write(require('node:fs').readFileSync(__dirname+'/resource','utf8')+':'+require('probe-dependency'))").unwrap();
            let ancestor_memory = unselected.join("CLAUDE.md");
            std::fs::write(&ancestor_memory, "@./memory-resource.md\n").unwrap();
            std::fs::write(
                unselected.join("memory-resource.md"),
                "separate-memory-resource",
            )
            .unwrap();
            let manifest = ClaudeInputManifest {
                version: 1,
                accepted_native_plan: None,
                native_source_runtime: Some(
                    freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
                ),
                original_home: home.clone(),
                cwd: cwd.clone(),
                workspace: cwd.clone(),
                config_root: None,
                settings_file: None,
                settings_origin: None,
                inline_settings_sha256: None,
                setting_sources: vec![ClaudeSettingSource::Project],
                plugin_dirs: vec![],
            };
            let selected = prepare(&home, &cwd, &cwd, Some(&manifest), &[])
                .expect("native-unselected command roots must not block preparation");
            let stage = owned.path().join("stage");
            copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
            let mount = selected
                .mounts
                .iter()
                .find(|mount| Path::new(&mount.logical_destination) == commands)
                .unwrap();
            let output = std::process::Command::new("node")
                .arg(stage.join(&mount.stage_relative_path).join("run.cjs"))
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                output.stdout,
                b"selected-command-resource:selected-installed-dependency"
            );
            let imported = selected
                .mounts
                .iter()
                .find(|mount| {
                    Path::new(&mount.logical_destination)
                        == manifest.runtime_path(&unselected.join("memory-resource.md"))
                })
                .expect("the resource boundary must not truncate eager memory imports");
            assert_eq!(
                std::fs::read(stage.join(&imported.stage_relative_path)).unwrap(),
                b"separate-memory-resource"
            );
            assert_eq!(
                std::fs::read_to_string(&ancestor_memory).unwrap(),
                "@./memory-resource.md\n"
            );
            assert_eq!(
                std::fs::read_link(unselected.join(".claude/commands")).unwrap(),
                Path::new("missing-unselected-commands")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_linked_resources_select_fallback_per_native_directory() {
        use std::os::unix::fs::PermissionsExt;
        for (case, checkout_commands, nested_commands, checkout_agents, custom_common) in [
            ("missing", false, false, false, false),
            ("empty-commands", true, false, false, false),
            ("nested-commands", false, true, false, false),
            ("independent-agents", true, true, false, true),
            ("empty-agents", false, false, true, false),
        ] {
            let owned = match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
                Some(root) => tempfile::Builder::new()
                    .prefix("claude-linked-resources-")
                    .tempdir_in(root)
                    .unwrap(),
                None => tempfile::tempdir().unwrap(),
            };
            let home = owned.path().join("home");
            let main = owned.path().join("main");
            let common = if custom_common {
                main.clone()
            } else {
                main.join(".git")
            };
            let checkout = owned.path().join("checkout");
            let cwd = checkout.join("nested");
            let gitdir = common.join("worktrees/fixture");
            for path in [&home, &cwd, &gitdir] {
                std::fs::create_dir_all(path).unwrap();
            }
            std::fs::write(
                checkout.join(".git"),
                format!("gitdir: {}\n", gitdir.display()),
            )
            .unwrap();
            std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
            std::fs::write(
                gitdir.join("gitdir"),
                format!("{}\n", checkout.join(".git").display()),
            )
            .unwrap();
            for category in ["commands", "agents"] {
                let root = main.join(".claude").join(category);
                std::fs::create_dir_all(root.join("node_modules/probe-dependency")).unwrap();
                std::fs::write(root.join("resource"), format!("{case}-{category}")).unwrap();
                std::fs::write(
                    root.join("node_modules/probe-dependency/index.js"),
                    "module.exports='installed-dependency'",
                )
                .unwrap();
                let executable = root.join("run.cjs");
                std::fs::write(&executable, "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(__dirname+'/resource','utf8')+':'+require('probe-dependency'))").unwrap();
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o750))
                    .unwrap();
            }
            if checkout_commands {
                std::fs::create_dir_all(checkout.join(".claude/commands")).unwrap();
            }
            if checkout_agents {
                std::fs::create_dir_all(checkout.join(".claude/agents")).unwrap();
            }
            if nested_commands {
                std::fs::create_dir_all(cwd.join(".claude/commands")).unwrap();
            }
            let manifest = ClaudeInputManifest {
                version: 1,
                accepted_native_plan: None,
                native_source_runtime: Some(
                    freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
                ),
                original_home: home.clone(),
                cwd: cwd.clone(),
                workspace: checkout.clone(),
                config_root: None,
                settings_file: None,
                settings_origin: None,
                inline_settings_sha256: None,
                setting_sources: vec![ClaudeSettingSource::Project],
                plugin_dirs: vec![],
            };
            let selected = prepare(&home, &cwd, &checkout, Some(&manifest), &[]).unwrap();
            let stage = owned.path().join("stage");
            copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
            for (category, suppressed) in
                [("commands", checkout_commands), ("agents", checkout_agents)]
            {
                let root = main.join(".claude").join(category);
                let mount = selected
                    .mounts
                    .iter()
                    .find(|mount| Path::new(&mount.logical_destination) == root);
                assert_eq!(
                    mount.is_none(),
                    suppressed,
                    "{case}: native fallback for {category}"
                );
                if let Some(mount) = mount {
                    let executable = stage.join(&mount.stage_relative_path).join("run.cjs");
                    let output = std::process::Command::new(&executable).output().unwrap();
                    assert!(
                        output.status.success(),
                        "{case}: selected {category} executable"
                    );
                    assert_eq!(
                        output.stdout,
                        format!("{case}-{category}:installed-dependency").as_bytes()
                    );
                    assert_eq!(
                        std::fs::metadata(&executable).unwrap().permissions().mode() & 0o111,
                        0o110
                    );
                }
                assert_eq!(
                    std::fs::read_to_string(root.join("resource")).unwrap(),
                    format!("{case}-{category}")
                );
                assert_eq!(
                    std::fs::metadata(root.join("run.cjs"))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o750
                );
            }
            assert_eq!(
                selected
                    .mounts
                    .iter()
                    .any(|mount| Path::new(&mount.logical_destination)
                        == cwd.join(".claude/commands")),
                nested_commands
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_git_native_trim_preserves_selected_and_unselected_resources() {
        use freshell_platform::claude_inputs::NativeSourceRuntime;
        for runtime in [NativeSourceRuntime::Terminal, NativeSourceRuntime::Sdk] {
            for field in ["marker", "common", "backlink"] {
                for (case, padding, main_selected) in
                    [("bom", "\u{feff} \t", true), ("nel", "\u{85}", false)]
                {
                    let owned = tempfile::tempdir().unwrap();
                    let home = owned.path().join("home");
                    let main = owned.path().join("main");
                    let checkout = owned.path().join("checkout");
                    let cwd = checkout.join("nested");
                    let gitdir = main.join(".git/worktrees/fixture");
                    for directory in [&home, &cwd, &gitdir] {
                        std::fs::create_dir_all(directory).unwrap();
                    }
                    let sources = [
                        (
                            "marker",
                            checkout.join(".git"),
                            format!("gitdir: {}", gitdir.display()),
                        ),
                        ("common", gitdir.join("commondir"), "../..".into()),
                        (
                            "backlink",
                            gitdir.join("gitdir"),
                            checkout.join(".git").to_str().unwrap().to_string(),
                        ),
                    ]
                    .map(|(kind, path, raw)| {
                        let raw = if kind == field {
                            format!("{padding}{raw}{padding}\n")
                        } else {
                            format!("{raw}\n")
                        };
                        std::fs::write(&path, &raw).unwrap();
                        (path, raw)
                    });
                    for (root, nonce) in [(&cwd, "cwd-source"), (&main, "canonical-source")] {
                        let commands = root.join(".claude/commands");
                        std::fs::create_dir_all(commands.join("node_modules/probe-dependency"))
                            .unwrap();
                        std::fs::write(commands.join("resource"), nonce).unwrap();
                        std::fs::write(
                            commands.join("node_modules/probe-dependency/index.js"),
                            "module.exports='installed-dependency'",
                        )
                        .unwrap();
                        std::fs::write(commands.join("consume.cjs"), "process.stdout.write(require('node:fs').readFileSync(__dirname+'/resource','utf8')+':'+require('probe-dependency'))").unwrap();
                    }
                    let poison = main.join(".claude/commands/unselected-broken-link");
                    if !main_selected {
                        std::os::unix::fs::symlink("missing-native-unselected-resource", &poison)
                            .unwrap();
                    }
                    let manifest = ClaudeInputManifest {
                        version: 1,
                        accepted_native_plan: None,
                        native_source_runtime: Some(runtime),
                        original_home: home.clone(),
                        cwd: cwd.clone(),
                        workspace: checkout.clone(),
                        config_root: None,
                        settings_file: None,
                        settings_origin: None,
                        inline_settings_sha256: None,
                        setting_sources: vec![ClaudeSettingSource::Project],
                        plugin_dirs: vec![],
                    };
                    let selected = prepare(&home, &cwd, &checkout, Some(&manifest), &[]).unwrap();
                    let canonical = main.join(".claude/commands");
                    assert_eq!(
                        selected
                            .mounts
                            .iter()
                            .any(|mount| Path::new(&mount.logical_destination) == canonical),
                        main_selected,
                        "{runtime:?}/{field}/{case}: native-effective canonical command selection"
                    );
                    let stage = owned.path().join("stage");
                    copy_environment(&selected.selections, &stage, &[], CopyLimits::default())
                        .unwrap();
                    for (root, nonce, enabled) in [
                        (&cwd, "cwd-source", true),
                        (&main, "canonical-source", main_selected),
                    ] {
                        if !enabled {
                            continue;
                        }
                        let commands = root.join(".claude/commands");
                        let mount = selected
                            .mounts
                            .iter()
                            .find(|mount| Path::new(&mount.logical_destination) == commands)
                            .unwrap();
                        let output = std::process::Command::new("node")
                            .arg(stage.join(&mount.stage_relative_path).join("consume.cjs"))
                            .output()
                            .unwrap();
                        assert!(output.status.success());
                        assert_eq!(
                            output.stdout,
                            format!("{nonce}:installed-dependency").as_bytes()
                        );
                        assert_eq!(
                            std::fs::read_to_string(commands.join("resource")).unwrap(),
                            nonce
                        );
                    }
                    for (path, raw) in sources {
                        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
                    }
                    if !main_selected {
                        assert_eq!(
                            std::fs::read_link(poison).unwrap(),
                            Path::new("missing-native-unselected-resource")
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn managed_provider_claude_git_lossy_source_view_limit_preserves_prior_copied_resources() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let commands = cwd.join(".claude/commands");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&commands).unwrap();
        std::fs::write(commands.join("resource"), "retained-selected-resource").unwrap();
        std::fs::write(
            commands.join("consume.cjs"),
            "process.stdout.write(require('node:fs').readFileSync(__dirname+'/resource'))",
        )
        .unwrap();
        std::fs::write(cwd.join(".git"), "ordinary native checkout marker\n").unwrap();
        let manifest = ClaudeInputManifest {
            version: 1,
            accepted_native_plan: None,
            native_source_runtime: Some(freshell_platform::claude_inputs::NativeSourceRuntime::Sdk),
            original_home: home.clone(),
            cwd: cwd.clone(),
            workspace: cwd.clone(),
            config_root: None,
            settings_file: None,
            settings_origin: None,
            inline_settings_sha256: None,
            setting_sources: vec![ClaudeSettingSource::Project],
            plugin_dirs: vec![],
        };
        let prior = prepare(&home, &cwd, &cwd, Some(&manifest), &[]).unwrap();
        let stage = owned.path().join("prior-copy");
        copy_environment(&prior.selections, &stage, &[], CopyLimits::default()).unwrap();
        let mount = prior
            .mounts
            .iter()
            .find(|mount| Path::new(&mount.logical_destination) == commands)
            .unwrap();
        let consume = || {
            let output = std::process::Command::new("node")
                .arg(stage.join(&mount.stage_relative_path).join("consume.cjs"))
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, b"retained-selected-resource");
        };
        consume();
        let mut expanded = b"gitdir: ".to_vec();
        expanded.resize(6 * 1024 * 1024, 0xff);
        std::fs::write(cwd.join(".git"), &expanded).unwrap();
        let error = prepare(&home, &cwd, &cwd, Some(&manifest), &[])
            .err()
            .unwrap();
        assert!(
            error.contains("16 MiB source-view"),
            "UTF-8 replacement expansion must be admitted before allocating a transformed view: {error}"
        );
        assert!(
            !error.contains('\u{fffd}'),
            "the rejected source must not enter errors"
        );
        consume();
        assert_eq!(std::fs::read(cwd.join(".git")).unwrap(), expanded);
        assert_eq!(
            std::fs::read_to_string(commands.join("resource")).unwrap(),
            "retained-selected-resource"
        );
        // Native trimming may consume a complete admitted view. One extra
        // input byte must fail without disturbing the already accepted copy.
        let maximum = freshell_platform::provider_input_profiles::MAX_SOURCE_VIEW_BYTES as usize;
        for (size, admitted) in [(maximum - 1, true), (maximum, true), (maximum + 1, false)] {
            let source = vec![b' '; size];
            std::fs::write(cwd.join(".git"), &source).unwrap();
            let next = prepare(&home, &cwd, &cwd, Some(&manifest), &[]);
            if admitted {
                let next = next.unwrap();
                let destination = owned.path().join(format!("admitted-{size}"));
                copy_environment(&next.selections, &destination, &[], CopyLimits::default())
                    .unwrap();
                let mount = next
                    .mounts
                    .iter()
                    .find(|mount| Path::new(&mount.logical_destination) == commands)
                    .unwrap();
                let output = std::process::Command::new("node")
                    .arg(
                        destination
                            .join(&mount.stage_relative_path)
                            .join("consume.cjs"),
                    )
                    .output()
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, b"retained-selected-resource");
            } else {
                assert!(next.err().unwrap().contains("16 MiB source-view"));
            }
            consume();
            assert_eq!(std::fs::read(cwd.join(".git")).unwrap(), source);
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_provider_claude_nested_linked_memory_retains_local_and_excludes_main_project_imports(
    ) {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let main = owned.path().join("main");
        let intermediate = main.join("checkouts");
        let checkout = intermediate.join("linked");
        let cwd = checkout.join("nested");
        let gitdir = main.join(".git/worktrees/linked");
        for path in [&home, &cwd, &gitdir] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        std::fs::write(
            gitdir.join("gitdir"),
            format!("{}\n", checkout.join(".git").display()),
        )
        .unwrap();
        for ancestor in [&main, &intermediate] {
            std::fs::create_dir_all(ancestor.join(".claude/rules")).unwrap();
            std::fs::write(ancestor.join("CLAUDE.md"), "@missing-main-project.md\n").unwrap();
            std::fs::write(
                ancestor.join(".claude/CLAUDE.md"),
                "@../missing-main-dotclaude.md\n",
            )
            .unwrap();
            std::fs::write(
                ancestor.join(".claude/rules/unselected.md"),
                "@missing-unselected-rule.md\n",
            )
            .unwrap();
            std::fs::write(ancestor.join("CLAUDE.local.md"), "@local-resource.md\n").unwrap();
            std::fs::write(
                ancestor.join("local-resource.md"),
                "selected-local-ancestor",
            )
            .unwrap();
        }
        std::fs::write(owned.path().join("CLAUDE.md"), "@above-main.md\n").unwrap();
        std::fs::write(owned.path().join("above-main.md"), "selected-above-main").unwrap();
        std::fs::write(checkout.join("CLAUDE.md"), "@checkout-resource.md\n").unwrap();
        std::fs::write(
            checkout.join("checkout-resource.md"),
            "selected-checkout-project",
        )
        .unwrap();
        let mut manifest = ClaudeInputManifest {
            version: 1,
            accepted_native_plan: None,
            native_source_runtime: Some(freshell_platform::claude_inputs::NativeSourceRuntime::Sdk),
            original_home: home.clone(),
            cwd: cwd.clone(),
            workspace: checkout.clone(),
            config_root: None,
            settings_file: None,
            settings_origin: None,
            inline_settings_sha256: None,
            setting_sources: vec![ClaudeSettingSource::Project, ClaudeSettingSource::Local],
            plugin_dirs: vec![],
        };
        for local_enabled in [true, false] {
            if !local_enabled {
                manifest.setting_sources = vec![ClaudeSettingSource::Project];
            }
            let selected = prepare(&home, &cwd, &checkout, Some(&manifest), &[])
                .expect("native-excluded main project memory must not resolve its broken imports");
            let stage = owned.path().join(if local_enabled {
                "with-local"
            } else {
                "without-local"
            });
            copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
            for (path, nonce) in [
                (owned.path().join("above-main.md"), "selected-above-main"),
                (
                    checkout.join("checkout-resource.md"),
                    "selected-checkout-project",
                ),
            ] {
                let mount = selected
                    .mounts
                    .iter()
                    .find(|mount| Path::new(&mount.logical_destination) == path)
                    .unwrap();
                let output = std::process::Command::new("node")
                    .args([
                        "-e",
                        "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
                    ])
                    .arg(stage.join(&mount.stage_relative_path))
                    .output()
                    .unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, nonce.as_bytes());
            }
            for ancestor in [&main, &intermediate] {
                let local = selected.mounts.iter().find(|mount| {
                    Path::new(&mount.logical_destination) == ancestor.join("local-resource.md")
                });
                assert_eq!(local.is_some(), local_enabled);
                if let Some(local) = local {
                    let output = std::process::Command::new("node").args(["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))"]).arg(stage.join(&local.stage_relative_path)).output().unwrap();
                    assert!(output.status.success());
                    assert_eq!(output.stdout, b"selected-local-ancestor");
                }
                assert!(!selected
                    .mounts
                    .iter()
                    .any(|mount| Path::new(&mount.logical_destination)
                        == ancestor.join("CLAUDE.md")
                        || Path::new(&mount.logical_destination)
                            == ancestor.join(".claude/CLAUDE.md")
                        || Path::new(&mount.logical_destination)
                            == ancestor.join(".claude/rules")));
                assert_eq!(
                    std::fs::read_to_string(ancestor.join("CLAUDE.md")).unwrap(),
                    "@missing-main-project.md\n"
                );
            }
        }
    }

    #[test]
    fn managed_provider_claude_selected_user_rules_keep_external_imports() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let rules = home.join(".claude/rules/nested");
        std::fs::create_dir_all(&rules).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let rule = rules.join("policy.md");
        let raw = "@../../../rule-memory.md\n`@../../../missing-inline.md`\n```\n@../../../missing-fence.md\n```\n";
        std::fs::write(&rule, raw).unwrap();
        std::fs::write(home.join("rule-memory.md"), "@./adjacent-memory.md\n").unwrap();
        std::fs::write(home.join("adjacent-memory.md"), "selected-rule-resource").unwrap();
        let selected = prepare(&home, &cwd, &cwd, None, &[]).unwrap();
        let stage = owned.path().join("stage");
        copy_environment(&selected.selections, &stage, &[], CopyLimits::default()).unwrap();
        let target = Path::new("/home/freshell/provider/adjacent-memory.md");
        let imported = selected
            .mounts
            .iter()
            .find(|mount| Path::new(&mount.logical_destination) == target)
            .expect("selected native user rule imports must enter the ordinary graph");
        let output = std::process::Command::new("node")
            .args([
                "-e",
                "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
            ])
            .arg(stage.join(&imported.stage_relative_path))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"selected-rule-resource");
        assert_eq!(std::fs::read_to_string(&rule).unwrap(), raw);
        // A failed next preparation cannot change the complete prior stage.
        std::fs::write(&rule, "@../../../missing-selected-rule.md\n").unwrap();
        let failed = prepare(&home, &cwd, &cwd, None, &[]).err().unwrap();
        assert!(failed.contains("missing-selected-rule.md"));
        assert_eq!(
            std::fs::read(stage.join(&imported.stage_relative_path)).unwrap(),
            b"selected-rule-resource"
        );
        std::fs::write(&rule, raw).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&rules, rules.join("cycle")).unwrap();
            let failed = prepare(&home, &cwd, &cwd, None, &[]).err().unwrap();
            assert!(failed.contains("cyclic selected rules directory"));
            assert_eq!(
                std::fs::read(stage.join(&imported.stage_relative_path)).unwrap(),
                b"selected-rule-resource"
            );
        }
    }

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
            accepted_native_plan: None,
            native_source_runtime: Some(
                freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
            ),
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
