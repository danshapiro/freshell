//! Ordered native source occurrences for managed OpenCode preparation.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SourceLane {
    Main,
    Tui,
}

pub struct SourceOccurrence {
    pub logical_path: PathBuf,
    pub canonical_source: PathBuf,
    pub lane: SourceLane,
}

pub struct OpencodeDiscovery<'a> {
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub worktree: &'a Path,
    pub config_root: &'a Path,
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

pub fn discover_opencode(
    request: OpencodeDiscovery<'_>,
) -> Result<Vec<SourceOccurrence>, &'static str> {
    let mut sources = Vec::new();
    let disabled = (request.env)("OPENCODE_DISABLE_PROJECT_CONFIG")
        .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    for name in ["config.json", "opencode.json", "opencode.jsonc"] {
        add_source(
            &mut sources,
            request.config_root.join(name),
            SourceLane::Main,
        )?;
    }
    if let Some(path) = (request.env)("OPENCODE_CONFIG").filter(|value| !value.is_empty()) {
        add_source(
            &mut sources,
            absolute_from_cwd(&path, request.cwd),
            SourceLane::Main,
        )?;
    }
    if !disabled {
        for directory in ancestors(request.cwd, Some(request.worktree))
            .into_iter()
            .rev()
        {
            for name in ["opencode.json", "opencode.jsonc"] {
                add_source(&mut sources, directory.join(name), SourceLane::Main)?;
            }
        }
    }
    for directory in config_directories(&request, Some(request.worktree), disabled)? {
        if directory.file_name() == Some(std::ffi::OsStr::new(".opencode"))
            || (request.env)("OPENCODE_CONFIG_DIR")
                .is_some_and(|path| absolute_from_cwd(&path, request.cwd) == directory)
        {
            for name in ["opencode.json", "opencode.jsonc"] {
                add_source(&mut sources, directory.join(name), SourceLane::Main)?;
            }
        }
    }
    for name in ["tui.json", "tui.jsonc"] {
        add_source(
            &mut sources,
            request.config_root.join(name),
            SourceLane::Tui,
        )?;
    }
    if let Some(path) = (request.env)("OPENCODE_TUI_CONFIG").filter(|value| !value.is_empty()) {
        add_source(
            &mut sources,
            absolute_from_cwd(&path, request.cwd),
            SourceLane::Tui,
        )?;
    }
    if !disabled {
        for directory in ancestors(request.cwd, None).into_iter().rev() {
            for name in ["tui.json", "tui.jsonc"] {
                add_source(&mut sources, directory.join(name), SourceLane::Tui)?;
            }
        }
    }
    for directory in config_directories(&request, None, disabled)? {
        if directory.file_name() == Some(std::ffi::OsStr::new(".opencode"))
            || (request.env)("OPENCODE_CONFIG_DIR")
                .is_some_and(|path| absolute_from_cwd(&path, request.cwd) == directory)
        {
            for name in ["tui.json", "tui.jsonc"] {
                add_source(&mut sources, directory.join(name), SourceLane::Tui)?;
            }
        }
    }
    Ok(sources)
}

fn absolute_from_cwd(path: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.into()
    } else {
        cwd.join(path)
    }
}

fn ancestors(start: &Path, stop: Option<&Path>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for directory in start.ancestors() {
        result.push(directory.to_owned());
        if Some(directory) == stop {
            break;
        }
    }
    result
}

pub fn config_directories(
    request: &OpencodeDiscovery<'_>,
    stop: Option<&Path>,
    disabled: bool,
) -> Result<Vec<PathBuf>, &'static str> {
    let mut result = vec![request.config_root.to_owned()];
    let mut candidates = Vec::new();
    if !disabled {
        candidates.extend(
            ancestors(request.cwd, stop)
                .into_iter()
                .map(|directory| directory.join(".opencode")),
        );
    }
    candidates.push(request.home.join(".opencode"));
    for directory in candidates {
        match std::fs::symlink_metadata(&directory) {
            Ok(_) => {
                if !std::fs::metadata(&directory)
                    .map_err(|_| "selected OpenCode config directory is unavailable")?
                    .is_dir()
                {
                    return Err("selected OpenCode config directory is not a directory");
                }
                if !result.contains(&directory) {
                    result.push(directory);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("selected OpenCode config directory metadata failed"),
        }
    }
    if let Some(path) = (request.env)("OPENCODE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        let directory = absolute_from_cwd(&path, request.cwd);
        if !result.contains(&directory) {
            result.push(directory);
        }
    }
    Ok(result)
}

fn add_source(
    sources: &mut Vec<SourceOccurrence>,
    logical_path: PathBuf,
    lane: SourceLane,
) -> Result<(), &'static str> {
    match std::fs::symlink_metadata(&logical_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("selected configuration source metadata failed"),
        Ok(_) => {}
    }
    if sources.len() >= 8192 {
        return Err("configuration source occurrence budget exceeded");
    }
    let canonical_source = std::fs::canonicalize(&logical_path)
        .map_err(|_| "selected configuration source is unavailable, dangling or cyclic")?;
    let metadata = std::fs::metadata(&canonical_source)
        .map_err(|_| "selected configuration source metadata failed")?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("selected configuration source is not a bounded regular file");
    }
    sources.push(SourceOccurrence {
        logical_path,
        canonical_source,
        lane,
    });
    Ok(())
}

pub struct PlannedSourceOccurrence {
    pub source: SourceOccurrence,
    pub references: super::ResolvedFileReferencePlan,
}

pub fn plan_opencode_sources(
    sources: Vec<SourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    use std::io::Read;
    let mut result = Vec::new();
    let mut selected = std::collections::BTreeMap::<PathBuf, String>::new();
    let mut selected_bytes = 0u64;
    let mut recipe_count = 0usize;
    let mut aliases = std::collections::BTreeSet::new();
    let mut variables = std::collections::BTreeSet::new();
    let mut event_count = 0usize;
    let mut retained_view_bytes = 0usize;
    for (ordinal, source) in sources.into_iter().enumerate() {
        let fail = |cause| super::ReferenceError {
            operation: "read",
            field: "OpenCode source",
            source_ordinal: ordinal,
            declaring_source: source.logical_path.clone(),
            variables: vec![],
            cause,
        };
        let mut raw = String::new();
        std::fs::File::open(&source.canonical_source)
            .map_err(|_| fail("selected source read failed"))?
            .take(16 * 1024 * 1024 + 1)
            .read_to_string(&mut raw)
            .map_err(|_| fail("selected source read failed or is not UTF-8"))?;
        if raw.len() > 16 * 1024 * 1024 {
            return Err(fail("selected source exceeds source-view limit"));
        }
        let mut allocate = |canonical: &Path| {
            if let Some(destination) = selected.get(canonical) {
                return Ok(destination.clone());
            }
            if selected.len() >= 128 {
                return Err("configuration reference count exceeds 128 across sources");
            }
            selected_bytes += std::fs::metadata(canonical)
                .map_err(|_| "selected source metadata failed")?
                .len();
            if selected_bytes > 32 * 1024 * 1024 {
                return Err("configuration references exceed 32 MiB across sources");
            }
            let destination = format!(
                "/home/freshell/provider/.freshell/references/{}",
                selected.len()
            );
            selected.insert(canonical.to_owned(), destination.clone());
            Ok(destination)
        };
        let references = super::resolve_file_references_allocated(
            &raw,
            super::FileSourceOrigin {
                declaring_config: &source.logical_path,
                cwd,
                original_home: home,
            },
            &|name| lookup(source.lane, &source.logical_path, name),
            recipe_count,
            &mut allocate,
        )?;
        recipe_count += references.recipes.len();
        retained_view_bytes = retained_view_bytes
            .checked_add(references.template.len())
            .and_then(|bytes| {
                references.recipes.iter().try_fold(bytes, |bytes, recipe| {
                    bytes.checked_add(recipe.unexpanded_source.len())
                })
            })
            .ok_or_else(|| fail("source-view byte count overflow"))?;
        if retained_view_bytes > 64 * 1024 * 1024 {
            return Err(fail("simultaneous retained source views exceed 64 MiB"));
        }
        aliases.extend(
            references
                .occurrences
                .iter()
                .map(|occurrence| occurrence.approved_alias.clone()),
        );
        variables.extend(references.referenced_variables.iter().cloned());
        event_count += references.occurrences.len();
        if recipe_count > 128 || aliases.len() > 256 || variables.len() > 128 || event_count > 8192
        {
            return Err(fail(
                "combined source recipe, alias, variable or event limit exceeded",
            ));
        }
        result.push(PlannedSourceOccurrence { source, references });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn digest(path: &Path) -> String {
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
    }
    #[test]
    fn managed_provider_references_discovery_keeps_native_order_origins_and_tui_ancestors() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let config = home.join(".config/opencode");
        let worktree = owned.path().join("project");
        let cwd = worktree.join("sub");
        let explicit = owned.path().join("selected/custom.json");
        let directory = owned.path().join("selected/config-dir");
        let files = [
            config.join("config.json"),
            config.join("opencode.json"),
            config.join("opencode.jsonc"),
            explicit.clone(),
            worktree.join("opencode.json"),
            worktree.join("opencode.jsonc"),
            cwd.join("opencode.json"),
            cwd.join(".opencode/opencode.json"),
            worktree.join(".opencode/opencode.json"),
            home.join(".opencode/opencode.json"),
            directory.join("opencode.json"),
            config.join("tui.json"),
            owned.path().join("tui.json"),
            worktree.join("tui.json"),
            cwd.join("tui.json"),
        ];
        for (ordinal, path) in files.iter().enumerate() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("{{\"model\":\"nonce-{ordinal}\"}}")).unwrap();
        }
        let env = |key: &str| match key {
            "OPENCODE_CONFIG" => Some(explicit.to_string_lossy().into_owned()),
            "OPENCODE_CONFIG_DIR" => Some(directory.to_string_lossy().into_owned()),
            _ => None,
        };
        let sources = discover_opencode(OpencodeDiscovery {
            home: &home,
            cwd: &cwd,
            worktree: &worktree,
            config_root: &config,
            env: &env,
        })
        .unwrap();
        let expected = files.iter().map(|path| digest(path)).collect::<Vec<_>>();
        let consumed = sources
            .iter()
            .map(|source| digest(&source.canonical_source))
            .collect::<Vec<_>>();
        assert_eq!(
            consumed, expected,
            "all native-selected configuration bytes must be available in their loader order"
        );
        for (source, logical) in sources.iter().zip(files) {
            assert_eq!(source.logical_path, logical);
        }
        assert!(sources[..11]
            .iter()
            .all(|source| source.lane == SourceLane::Main));
        assert!(sources[11..]
            .iter()
            .all(|source| source.lane == SourceLane::Tui));
        assert_eq!(digest(&explicit), expected[3]);
    }

    #[test]
    fn managed_provider_references_source_plan_assigns_distinct_global_payload_destinations() {
        let owned = tempfile::tempdir().unwrap();
        let cwd = owned.path().join("workspace");
        let home = owned.path().join("home");
        let mut sources = Vec::new();
        for name in ["first", "second"] {
            let dir = cwd.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            let config = dir.join("opencode.json");
            std::fs::write(&config, "{\"instructions\":[\"{file:rules}\"]}").unwrap();
            std::fs::write(dir.join("rules"), name).unwrap();
            sources.push(SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
            });
        }
        let plan = plan_opencode_sources(sources, &cwd, &home, &|_, _, _| None).unwrap();
        let destinations = plan
            .iter()
            .map(|source| source.references.selections[0].runtime_destination.clone())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            destinations.len(),
            2,
            "distinct source-origin payloads cannot overwrite the same runtime destination"
        );
        for source in plan {
            assert_eq!(
                std::fs::read_to_string(&source.source.canonical_source).unwrap(),
                "{\"instructions\":[\"{file:rules}\"]}"
            );
            assert!(source
                .references
                .template
                .contains(&source.references.selections[0].runtime_destination));
        }
    }

    #[test]
    fn managed_provider_references_source_plan_shares_one_identity_and_rejects_generated_name_collision(
    ) {
        let owned = tempfile::tempdir().unwrap();
        let config = owned.path().join("opencode.json");
        let payload = owned.path().join("rules");
        std::fs::write(&payload, "approved-payload").unwrap();
        std::fs::write(&config, "{\"instructions\":[\"{env:INSERT}\"]}").unwrap();
        let sources = || {
            [SourceLane::Main, SourceLane::Tui]
                .into_iter()
                .map(|lane| SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane,
                })
                .collect()
        };
        let plan = plan_opencode_sources(sources(), owned.path(), owned.path(), &|_, _, name| {
            (name == "INSERT").then(|| "prefix{file:rules}suffix".into())
        })
        .unwrap();
        assert_eq!(
            plan[0].references.selections[0].runtime_destination,
            plan[1].references.selections[0].runtime_destination
        );
        assert_ne!(
            plan[0].references.recipes[0].generated_name,
            plan[1].references.recipes[0].generated_name
        );
        let collision = plan_opencode_sources(
            sources(),
            owned.path(),
            owned.path(),
            &|_, _, name| match name {
                "INSERT" => Some("prefix{file:rules}suffix".into()),
                "FRESHELL_CONFIG_REFERENCE_0" => Some("user-owned-value".into()),
                _ => None,
            },
        );
        assert!(
            collision.is_err(),
            "generated child names cannot shadow user or source-specific auth values"
        );
    }
}
