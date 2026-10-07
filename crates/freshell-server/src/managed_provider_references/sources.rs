//! Ordered native source occurrences for managed OpenCode preparation.
pub use freshell_platform::opencode_recipe::{DiscoveryRole, DiscoveryRoot};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SourceLane {
    Main,
    Tui,
    Inline,
}

pub struct SourceOccurrence {
    pub logical_path: PathBuf,
    pub canonical_source: PathBuf,
    pub lane: SourceLane,
    pub role: DiscoveryRole,
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
            DiscoveryRole::Global,
        )?;
    }
    if let Some(path) = (request.env)("OPENCODE_CONFIG").filter(|value| !value.is_empty()) {
        add_source(
            &mut sources,
            absolute_from_cwd(&path, request.cwd),
            SourceLane::Main,
            DiscoveryRole::Workspace,
        )?;
    }
    if !disabled {
        for directory in ancestors(request.cwd, Some(request.worktree))
            .into_iter()
            .rev()
        {
            for name in ["opencode.json", "opencode.jsonc"] {
                add_source(
                    &mut sources,
                    directory.join(name),
                    SourceLane::Main,
                    DiscoveryRole::Workspace,
                )?;
            }
        }
    }
    for directory in config_directories(&request, Some(request.worktree), disabled)? {
        if directory.logical_path.file_name() == Some(std::ffi::OsStr::new(".opencode"))
            || (request.env)("OPENCODE_CONFIG_DIR")
                .is_some_and(|path| absolute_from_cwd(&path, request.cwd) == directory.logical_path)
        {
            for name in ["opencode.json", "opencode.jsonc"] {
                add_source(
                    &mut sources,
                    directory.logical_path.join(name),
                    SourceLane::Main,
                    directory.role,
                )?;
            }
        }
    }
    for name in ["tui.json", "tui.jsonc"] {
        add_source(
            &mut sources,
            request.config_root.join(name),
            SourceLane::Tui,
            DiscoveryRole::Global,
        )?;
    }
    if let Some(path) = (request.env)("OPENCODE_TUI_CONFIG").filter(|value| !value.is_empty()) {
        add_source(
            &mut sources,
            absolute_from_cwd(&path, request.cwd),
            SourceLane::Tui,
            DiscoveryRole::Workspace,
        )?;
    }
    if !disabled {
        for directory in ancestors(request.cwd, None).into_iter().rev() {
            for name in ["tui.json", "tui.jsonc"] {
                add_source(
                    &mut sources,
                    directory.join(name),
                    SourceLane::Tui,
                    DiscoveryRole::Workspace,
                )?;
            }
        }
    }
    for directory in config_directories(&request, None, disabled)? {
        if directory.logical_path.file_name() == Some(std::ffi::OsStr::new(".opencode"))
            || (request.env)("OPENCODE_CONFIG_DIR")
                .is_some_and(|path| absolute_from_cwd(&path, request.cwd) == directory.logical_path)
        {
            for name in ["tui.json", "tui.jsonc"] {
                add_source(
                    &mut sources,
                    directory.logical_path.join(name),
                    SourceLane::Tui,
                    directory.role,
                )?;
            }
        }
    }
    Ok(sources)
}

pub fn runtime_config_destination(
    home: &Path,
    global: &Path,
    logical: &Path,
    role: DiscoveryRole,
) -> PathBuf {
    let runtime_home = Path::new("/home/freshell/provider");
    match role {
        DiscoveryRole::Global => logical
            .strip_prefix(global)
            .map(|relative| runtime_home.join(".config/opencode").join(relative))
            .unwrap_or_else(|_| logical.into()),
        DiscoveryRole::Home => logical
            .strip_prefix(home)
            .map(|relative| runtime_home.join(relative))
            .unwrap_or_else(|_| logical.into()),
        DiscoveryRole::Workspace | DiscoveryRole::Unknown => logical.into(),
    }
}

pub fn runtime_directory_destination(
    home: &Path,
    global: &Path,
    logical: &Path,
    role: DiscoveryRole,
) -> PathBuf {
    runtime_config_destination(
        home,
        global,
        &freshell_platform::opencode_config::lexical_path(logical),
        role,
    )
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
) -> Result<Vec<DiscoveryRoot>, &'static str> {
    let mut result = vec![DiscoveryRoot {
        logical_path: request.config_root.to_owned(),
        role: DiscoveryRole::Global,
    }];
    let mut candidates = Vec::new();
    if !disabled {
        candidates.extend(ancestors(request.cwd, stop).into_iter().map(|directory| {
            DiscoveryRoot {
                logical_path: directory.join(".opencode"),
                role: DiscoveryRole::Workspace,
            }
        }));
    }
    candidates.push(DiscoveryRoot {
        logical_path: request.home.join(".opencode"),
        role: DiscoveryRole::Home,
    });
    for directory in candidates {
        match std::fs::symlink_metadata(&directory.logical_path) {
            Ok(_) => {
                if !std::fs::metadata(&directory.logical_path)
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
        let directory = DiscoveryRoot {
            logical_path: absolute_from_cwd(&path, request.cwd),
            role: DiscoveryRole::Workspace,
        };
        if !result.contains(&directory) {
            result.push(directory);
        }
    }
    Ok(result)
}

/// Native discovery includes directories with plugins or skills even when no
/// configuration document exists. Keep these selections independent of files.
pub fn select_opencode_resource_roots(
    request: &OpencodeDiscovery<'_>,
) -> Result<Vec<DiscoveryRoot>, &'static str> {
    let disabled = (request.env)("OPENCODE_DISABLE_PROJECT_CONFIG")
        .is_some_and(|value| matches!(value.as_str(), "1" | "true"));
    let mut roots = config_directories(request, None, disabled)?;
    for (directory, role) in std::iter::once((request.home.to_path_buf(), DiscoveryRole::Home))
        .chain(
            ancestors(request.cwd, Some(request.worktree))
                .into_iter()
                .map(|path| (path, DiscoveryRole::Workspace)),
        )
    {
        for name in [".claude/skills", ".agents/skills"] {
            let path = directory.join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(_) => {
                    let root = DiscoveryRoot {
                        logical_path: path,
                        role,
                    };
                    if !roots.contains(&root) {
                        roots.push(root);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("selected OpenCode skill root metadata failed"),
            }
        }
    }
    roots.retain(|root| root.role != DiscoveryRole::Global);
    for root in &roots {
        let canonical = std::fs::canonicalize(&root.logical_path).map_err(|_| {
            "selected OpenCode resource directory is missing, inaccessible or cyclic"
        })?;
        if !canonical.is_dir() || canonical == request.home || canonical == Path::new("/") {
            return Err("selected OpenCode resource requires a bounded directory scope");
        }
    }
    Ok(roots)
}

fn add_source(
    sources: &mut Vec<SourceOccurrence>,
    logical_path: PathBuf,
    lane: SourceLane,
    role: DiscoveryRole,
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
        role,
    });
    Ok(())
}

pub struct PlannedSourceOccurrence {
    pub source: SourceOccurrence,
    pub references: super::ResolvedFileReferencePlan,
    pub original_form: bool,
}

pub struct LoadedSourceOccurrence {
    pub source: SourceOccurrence,
    pub view: std::sync::Arc<String>,
}

/// Retain one bounded canonical read while keeping every native logical origin.
/// Authentication lookup can select its finite keys from these same views.
pub fn read_opencode_sources(
    sources: Vec<SourceOccurrence>,
) -> Result<Vec<LoadedSourceOccurrence>, super::ReferenceError> {
    use std::io::Read;
    let mut loaded = Vec::new();
    let mut canonical = std::collections::BTreeMap::<PathBuf, std::sync::Arc<String>>::new();
    let mut retained = 0usize;
    for (ordinal, source) in sources.into_iter().enumerate() {
        let fail = |cause| super::ReferenceError {
            operation: "read",
            field: "OpenCode source",
            source_ordinal: ordinal,
            declaring_source: source.logical_path.clone(),
            variables: vec![],
            cause,
        };
        if ordinal >= 8192 {
            return Err(fail("source occurrence budget exceeded"));
        }
        let view = if let Some(view) = canonical.get(&source.canonical_source) {
            view.clone()
        } else {
            let remaining = (64 * 1024 * 1024usize)
                .checked_sub(retained)
                .ok_or_else(|| fail("source-view byte count overflow"))?;
            let limit = remaining.min(16 * 1024 * 1024);
            let mut raw = String::new();
            std::fs::File::open(&source.canonical_source)
                .map_err(|_| fail("selected source read failed"))?
                .take(limit as u64 + 1)
                .read_to_string(&mut raw)
                .map_err(|_| fail("selected source read failed or is not UTF-8"))?;
            if raw.len() > limit {
                return Err(fail("selected source exceeds source-view limit"));
            }
            let view = std::sync::Arc::new(raw);
            canonical.insert(source.canonical_source.clone(), view.clone());
            view
        };
        retained = retained
            .checked_add(view.len())
            .ok_or_else(|| fail("source-view byte count overflow"))?;
        if retained > 64 * 1024 * 1024 {
            return Err(fail("simultaneous retained source views exceed 64 MiB"));
        }
        loaded.push(LoadedSourceOccurrence { source, view });
    }
    Ok(loaded)
}

pub fn source_environment_names(
    sources: &[LoadedSourceOccurrence],
) -> Result<Vec<String>, super::ReferenceError> {
    let mut names = std::collections::BTreeSet::new();
    let mut events = 0usize;
    for (ordinal, source) in sources.iter().enumerate() {
        let fail = |cause| super::ReferenceError {
            operation: "select",
            field: "OpenCode source",
            source_ordinal: ordinal,
            declaring_source: source.source.logical_path.clone(),
            variables: vec![],
            cause,
        };
        let mut cursor = 0;
        while let Some(relative) = source.view[cursor..].find("{env:") {
            let start = cursor + relative + 5;
            let Some(close) = source.view[start..]
                .find('}')
                .map(|relative| start + relative)
            else {
                break;
            };
            cursor = close + 1;
            let name = &source.view[start..close];
            if name.is_empty() {
                continue;
            }
            if name.len() > 128 || name.chars().any(char::is_control) {
                return Err(fail("referenced variable name profile exceeded"));
            }
            events = events
                .checked_add(1)
                .ok_or_else(|| fail("substitution event count overflow"))?;
            if events > 8192 || names.len() >= 128 && !names.contains(name) {
                return Err(fail("combined source variable or event limit exceeded"));
            }
            names.insert(name.to_owned());
        }
    }
    Ok(names.into_iter().collect())
}

pub fn plan_opencode_sources(
    sources: Vec<SourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    plan_loaded_opencode_sources(read_opencode_sources(sources)?, cwd, home, lookup)
}

pub fn plan_loaded_opencode_sources(
    sources: Vec<LoadedSourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    plan_loaded_opencode_sources_relocated(
        sources,
        cwd,
        home,
        lookup,
        &std::collections::BTreeMap::new(),
    )
}
pub fn plan_loaded_opencode_sources_relocated(
    sources: Vec<LoadedSourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
    relocated_files: &std::collections::BTreeMap<PathBuf, PathBuf>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    let original_names = source_environment_names(&sources)?;
    let mut canonical_occurrences = std::collections::BTreeMap::new();
    for source in &sources {
        *canonical_occurrences
            .entry(source.source.canonical_source.clone())
            .or_insert(0usize) += 1;
    }
    let mut result: Vec<PlannedSourceOccurrence> = Vec::new();
    let mut selected = std::collections::BTreeMap::<PathBuf, String>::new();
    let mut selected_bytes = 0u64;
    let mut recipe_count = 0usize;
    let mut aliases = std::collections::BTreeSet::new();
    let mut variables = std::collections::BTreeSet::new();
    let mut event_count = 0usize;
    let mut retained_view_bytes = 0usize;
    for (ordinal, loaded) in sources.into_iter().enumerate() {
        let source = loaded.source;
        let original_form = source.lane != SourceLane::Inline
            && canonical_occurrences[&source.canonical_source] > 1;
        let fail = |cause| super::ReferenceError {
            operation: "read",
            field: "OpenCode source",
            source_ordinal: ordinal,
            declaring_source: source.logical_path.clone(),
            variables: vec![],
            cause,
        };
        for index in 0..freshell_platform::opencode_config::MAX_GENERATED_CONFIG_REFERENCES {
            if lookup(
                source.lane,
                &source.logical_path,
                &freshell_platform::opencode_config::generated_config_reference_name(index),
            )
            .is_some()
            {
                return Err(fail(
                    "original or source-specific input occupies the reserved generated namespace",
                ));
            }
        }
        let mut allocate = |canonical: &Path| {
            if let Some(destination) = selected.get(canonical) {
                return Ok(destination.clone());
            }
            if selected.len() >= 128 {
                return Err("configuration reference count exceeds 128 across sources");
            }
            selected_bytes = selected_bytes
                .checked_add(
                    std::fs::metadata(canonical)
                        .map_err(|_| "selected source metadata failed")?
                        .len(),
                )
                .ok_or("selected reference size overflow")?;
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
        let references = super::resolve_file_references_from_view_relocated(
            &loaded.view,
            Some(loaded.view.clone()),
            super::FileSourceOrigin {
                declaring_config: &source.logical_path,
                cwd,
                original_home: home,
            },
            &|name| lookup(source.lane, &source.logical_path, name),
            recipe_count,
            &mut allocate,
            super::ReferenceProjection {
                relocated_files,
                original_form,
            },
        )?;
        if original_form {
            if let Some(prior) = result
                .iter()
                .find(|prior| prior.source.canonical_source == source.canonical_source)
            {
                if prior.references.template != references.template {
                    return Err(fail("shared source requires incompatible native lane edits; retain its inputs and reprepare before dispatch"));
                }
            }
        }
        if references
            .recipes
            .iter()
            .any(|recipe| original_names.contains(&recipe.generated_name))
        {
            return Err(fail(
                "generated configuration name collides with an original source input",
            ));
        }
        recipe_count = recipe_count
            .checked_add(references.recipes.len())
            .ok_or_else(|| fail("source recipe count overflow"))?;
        retained_view_bytes = retained_view_bytes
            .checked_add(references.template.len())
            .and_then(|bytes| bytes.checked_add(references.unexpanded_source().len()))
            .ok_or_else(|| fail("source-view byte count overflow"))?;
        if retained_view_bytes > 64 * 1024 * 1024 {
            return Err(fail("simultaneous retained source views exceed 64 MiB"));
        }
        for occurrence in &references.occurrences {
            if aliases.len() >= 256 && !aliases.contains(&occurrence.approved_alias) {
                return Err(fail("configuration alias count exceeds 256 across sources"));
            }
            aliases.insert(occurrence.approved_alias.clone());
        }
        for name in &references.referenced_variables {
            if variables.len() >= 128 && !variables.contains(name) {
                return Err(fail("referenced variable count exceeds 128 across sources"));
            }
            variables.insert(name.clone());
        }
        event_count = event_count
            .checked_add(references.substitution_events)
            .ok_or_else(|| fail("source substitution event count overflow"))?;
        if recipe_count > 128 || aliases.len() > 256 || variables.len() > 128 || event_count > 8192
        {
            return Err(fail(
                "combined source recipe, alias, variable or event limit exceeded",
            ));
        }
        result.push(PlannedSourceOccurrence {
            source,
            references,
            original_form,
        });
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
    fn managed_provider_references_shared_source_is_read_once_before_auth_lookup() {
        let owned = tempfile::tempdir().unwrap();
        let left = owned.path().join("left");
        let right = owned.path().join("right");
        std::fs::create_dir(&left).unwrap();
        std::fs::create_dir(&right).unwrap();
        std::fs::write(left.join("rules"), b"LEFT_PRIVATE_PAYLOAD").unwrap();
        std::fs::write(right.join("rules"), b"RIGHT_PRIVATE_PAYLOAD").unwrap();
        let shared = owned.path().join("shared.json");
        let raw = r#"{"model":"{env:MODEL}","instructions":["{file:./rules}"]}"#;
        std::fs::write(&shared, raw).unwrap();
        let sources = vec![
            SourceOccurrence {
                logical_path: left.join("opencode.json"),
                canonical_source: shared.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
            SourceOccurrence {
                logical_path: right.join("opencode.json"),
                canonical_source: shared.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
        ];
        let lookups = std::cell::Cell::new(0);
        let plans = plan_opencode_sources(sources, owned.path(), owned.path(), &|_, _, name| {
            if name == "MODEL" {
                if lookups.get() == 0 {
                    std::fs::write(&shared, r#"{"model":"CHANGED_SOURCE"}"#).unwrap();
                }
                lookups.set(lookups.get() + 1);
                Some("synthetic-model".into())
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].references.unexpanded_source(), raw);
        assert_eq!(plans[1].references.unexpanded_source(),raw,
            "auth selection and planning must share the same bounded source read for every canonical source occurrence");
        assert_eq!(
            plans[0].references.selections[0].canonical_source,
            left.join("rules")
        );
        assert_eq!(
            plans[1].references.selections[0].canonical_source,
            right.join("rules"),
            "one canonical read must retain both logical declaring parents"
        );
        assert_eq!(lookups.get(), 2);
    }

    #[test]
    fn managed_provider_references_retained_views_select_keys_and_reject_cross_source_name_collision(
    ) {
        let owned = tempfile::tempdir().unwrap();
        std::fs::write(owned.path().join("rules"), b"PRIVATE_RULES").unwrap();
        let first = owned.path().join("opencode.json");
        let second = owned.path().join("tui.json");
        std::fs::write(
            &first,
            r#"{"instructions":["{env:INSERT}"],"model":"{env:MODEL}"}"#,
        )
        .unwrap();
        std::fs::write(&second, r#"{"model":"{env:FRESHELL_CONFIG_REFERENCE_0}"}"#).unwrap();
        let sources = vec![
            SourceOccurrence {
                logical_path: first.clone(),
                canonical_source: first.clone(),
                lane: SourceLane::Main,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
            SourceOccurrence {
                logical_path: second.clone(),
                canonical_source: second,
                lane: SourceLane::Tui,
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
            },
        ];
        let loaded = read_opencode_sources(sources).unwrap();
        assert_eq!(
            source_environment_names(&loaded).unwrap(),
            vec!["FRESHELL_CONFIG_REFERENCE_0", "INSERT", "MODEL"]
        );
        std::fs::remove_file(first).unwrap();
        let error = plan_loaded_opencode_sources(
            loaded,
            owned.path(),
            owned.path(),
            &|_, _, name| (name == "INSERT").then(|| "{file:rules}".into()),
        )
        .err()
        .expect(
            "an original selected source variable cannot become an unrelated generated document",
        );
        assert_eq!(
            error.cause,
            "generated configuration name collides with an original source input"
        );
        assert!(!error.to_string().contains("PRIVATE_RULES"));
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
                role: freshell_platform::opencode_recipe::DiscoveryRole::Workspace,
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
                    role: DiscoveryRole::Workspace,
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
        for source in &plan {
            assert!(
                source.original_form,
                "shared main/TUI source must retain native lane evaluation"
            );
            assert!(
                source.references.recipes.is_empty(),
                "one shared source cannot receive two lane-specific document wrappers"
            );
            assert_eq!(
                source.references.unexpanded_source(),
                "{\"instructions\":[\"{env:INSERT}\"]}"
            );
        }
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
