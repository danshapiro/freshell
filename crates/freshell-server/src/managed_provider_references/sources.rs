//! Ordered native source occurrences for managed OpenCode preparation.
pub use freshell_platform::opencode_recipe::{DiscoveryRole, DiscoveryRoot};
use freshell_platform::provider_input_profiles::{
    MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES, MAX_SOURCE_VIEW_BYTES,
};
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
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_VIEW_BYTES {
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
    pub requires_config_bind: bool,
    pub instance_cwd: PathBuf,
    pub configured_resources: Vec<PathBuf>,
    /// Captured with the retained source view so later staging does not
    /// reinterpret a generated entry after ordinary-terminal cleanup.
    pub user_owns_freshell_mcp: bool,
}

#[derive(Default)]
pub(crate) struct SourceViewBudget {
    views: std::collections::BTreeSet<(usize, usize)>,
    pub bytes: usize,
}
impl SourceViewBudget {
    pub fn charge(&mut self, view: &str) -> Result<(), &'static str> {
        if view.len() as u64 > MAX_SOURCE_VIEW_BYTES {
            return Err("source view exceeds 16 MiB");
        }
        let identity = (view.as_ptr() as usize, view.len());
        if self.views.contains(&identity) {
            return Ok(());
        }
        let bytes = self
            .bytes
            .checked_add(view.len())
            .ok_or("source-view byte count overflow")?;
        if bytes as u64 > MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES {
            return Err("simultaneous retained source views exceed 64 MiB");
        }
        self.views.insert(identity);
        self.bytes = bytes;
        Ok(())
    }
}

pub fn retained_source_view_bytes(
    sources: &[LoadedSourceOccurrence],
) -> Result<usize, &'static str> {
    let mut budget = SourceViewBudget::default();
    for source in sources {
        budget.charge(&source.view)?;
    }
    Ok(budget.bytes)
}

/// Capture generated-versus-user MCP ownership only after all retained source
/// views pass the shared byte bound. The snapshot then travels with the views
/// through resource selection and staging.
pub fn snapshot_freshell_mcp_ownership(
    sources: &mut [LoadedSourceOccurrence],
) -> Result<(), super::ReferenceError> {
    let mut budget = SourceViewBudget::default();
    for source in sources.iter() {
        budget
            .charge(&source.view)
            .map_err(|cause| super::ReferenceError {
                preparation_failure: None,
                operation: "read",
                field: "OpenCode source",
                source_ordinal: 0,
                declaring_source: source.source.logical_path.clone(),
                variables: vec![],
                cause,
            })?;
    }
    snapshot_freshell_mcp_ownership_after_budget(sources)?;
    Ok(())
}

fn snapshot_freshell_mcp_ownership_after_budget(
    sources: &mut [LoadedSourceOccurrence],
) -> Result<(), super::ReferenceError> {
    for (ordinal, source) in sources.iter_mut().enumerate() {
        if source.mcp_ownership_snapshot.is_some() {
            continue;
        }
        source.mcp_ownership_snapshot = Some(if source.source.lane == SourceLane::Main {
            freshell_platform::opencode_config::source_owns_freshell_mcp(
                &source.view,
                &source.source.logical_path,
            )
            .map_err(|_| super::ReferenceError {
                preparation_failure: None,
                operation: "select",
                field: "OpenCode MCP ownership",
                source_ordinal: ordinal,
                declaring_source: source.source.logical_path.clone(),
                variables: vec![],
                cause: "selected source MCP ownership could not be determined",
            })?
        } else {
            false
        });
    }
    Ok(())
}

pub struct LoadedSourceOccurrence {
    pub source: SourceOccurrence,
    pub view: std::sync::Arc<String>,
    pub requires_config_bind: bool,
    pub mcp_ownership_snapshot: Option<bool>,
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
            preparation_failure: None,
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
            let remaining = (MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES as usize)
                .checked_sub(retained)
                .ok_or_else(|| fail("source-view byte count overflow"))?;
            let limit = remaining.min(MAX_SOURCE_VIEW_BYTES as usize);
            let metadata = std::fs::metadata(&source.canonical_source)
                .map_err(|_| fail("selected source read failed"))?;
            if !metadata.is_file() || metadata.len() > limit as u64 {
                return Err(fail("selected source exceeds source-view limit"));
            }
            let mut raw = String::new();
            std::fs::File::open(&source.canonical_source)
                .map_err(|_| fail("selected source read failed"))?
                .take(limit as u64 + 1)
                .read_to_string(&mut raw)
                .map_err(|_| fail("selected source read failed or is not UTF-8"))?;
            if raw.len() > limit {
                return Err(fail("selected source exceeds source-view limit"));
            }
            retained = retained
                .checked_add(raw.len())
                .ok_or_else(|| fail("source-view byte count overflow"))?;
            let view = std::sync::Arc::new(raw);
            canonical.insert(source.canonical_source.clone(), view.clone());
            view
        };
        loaded.push(LoadedSourceOccurrence {
            source,
            view,
            requires_config_bind: false,
            mcp_ownership_snapshot: None,
        });
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
            preparation_failure: None,
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

#[cfg(test)]
pub fn plan_opencode_sources(
    sources: Vec<SourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    plan_loaded_opencode_sources(read_opencode_sources(sources)?, cwd, home, lookup)
}

#[cfg(test)]
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
    mut sources: Vec<LoadedSourceOccurrence>,
    cwd: &Path,
    home: &Path,
    lookup: &dyn Fn(SourceLane, &Path, &str) -> Option<String>,
    relocated_files: &std::collections::BTreeMap<PathBuf, PathBuf>,
) -> Result<Vec<PlannedSourceOccurrence>, super::ReferenceError> {
    let global = sources
        .iter()
        .find(|source| source.source.role == DiscoveryRole::Global)
        .and_then(|source| source.source.logical_path.parent())
        .map(Path::to_owned);
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
    let mut view_budget = SourceViewBudget::default();
    // All unprocessed originals are still live while the first source is
    // transformed. Include them, plus retained outputs from earlier sources.
    for loaded in &sources {
        view_budget
            .charge(&loaded.view)
            .map_err(|cause| super::ReferenceError {
                preparation_failure: None,
                operation: "read",
                field: "OpenCode source",
                source_ordinal: 0,
                declaring_source: loaded.source.logical_path.clone(),
                variables: vec![],
                cause,
            })?;
    }
    snapshot_freshell_mcp_ownership_after_budget(&mut sources)?;
    for (ordinal, loaded) in sources.into_iter().enumerate() {
        let user_owns_freshell_mcp = loaded.mcp_ownership_snapshot.unwrap_or(false);
        let source = loaded.source;
        let original_form = source.lane != SourceLane::Inline
            && canonical_occurrences[&source.canonical_source] > 1;
        let fail = |cause| super::ReferenceError {
            preparation_failure: None,
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
                available_view_bytes: MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES as usize
                    - view_budget.bytes,
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
        view_budget.charge(&references.template).map_err(fail)?;
        if references.unexpanded_direct_source.is_none() {
            // Generated recipes own a replacement raw view. Its original Arc
            // cannot be shared by another occurrence (those use original form).
            let identity = (loaded.view.as_ptr() as usize, loaded.view.len());
            if view_budget.views.remove(&identity) {
                view_budget.bytes -= loaded.view.len();
            }
        }
        view_budget
            .charge(references.unexpanded_source())
            .map_err(fail)?;
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
        let mut planned = PlannedSourceOccurrence {
            source,
            references,
            original_form,
            requires_config_bind: loaded.requires_config_bind,
            instance_cwd: cwd.into(),
            configured_resources: Vec::new(),
            user_owns_freshell_mcp,
        };
        let (resources, names) =
            super::opencode_resources::select(&planned, home, global.as_deref(), &|name| {
                lookup(planned.source.lane, &planned.source.logical_path, name)
            })
            .map_err(|error| super::ReferenceError {
                preparation_failure: None,
                operation: "select",
                field: error.field,
                source_ordinal: ordinal,
                declaring_source: planned.source.logical_path.clone(),
                variables: vec![],
                cause: error.cause,
            })?;
        planned.configured_resources = resources;
        planned.references.path_variables.extend(names);
        planned.references.path_variables.sort();
        planned.references.path_variables.dedup();
        result.push(planned);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn managed_provider_references_actual_source_file_growth_rejects_before_reading() {
        let owned = tempfile::tempdir().unwrap();
        let path = owned.path().join("opencode.json");
        let file = std::fs::File::create(&path).unwrap();
        let mut sources = Vec::new();
        add_source(
            &mut sources,
            path.clone(),
            SourceLane::Main,
            DiscoveryRole::Workspace,
        )
        .unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();
        let unread = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        file.set_times(std::fs::FileTimes::new().set_accessed(unread))
            .unwrap();
        assert!(read_opencode_sources(sources).is_err());
        assert_eq!(
            file.metadata().unwrap().accessed().unwrap(),
            unread,
            "growth beyond the actual per-source limit must fail before reading source bytes"
        );
    }

    #[test]
    fn managed_provider_references_actual_aggregate_view_limit_rejects_before_extra_read() {
        let owned = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for ordinal in 0..4 {
            let path = owned.path().join(format!("source-{ordinal}.json"));
            std::fs::File::create(&path)
                .unwrap()
                .set_len(16 * 1024 * 1024)
                .unwrap();
            paths.push(path);
        }
        let occurrences = |paths: &[PathBuf]| {
            paths
                .iter()
                .map(|path| SourceOccurrence {
                    logical_path: path.clone(),
                    canonical_source: path.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Workspace,
                })
                .collect()
        };
        let mut repeated = paths.clone();
        repeated.push(paths[0].clone());
        let loaded = read_opencode_sources(occurrences(&repeated)).unwrap();
        assert_eq!(
            retained_source_view_bytes(&loaded).unwrap(),
            64 * 1024 * 1024
        );
        assert!(std::sync::Arc::ptr_eq(&loaded[0].view, &loaded[4].view));
        assert!(loaded.iter().all(|source| {
            source.view.len() == 16 * 1024 * 1024
                && source.view.as_bytes().iter().all(|byte| *byte == 0)
        }));
        drop(loaded);
        let extra = owned.path().join("extra.json");
        let extra_file = std::fs::File::create(&extra).unwrap();
        extra_file.set_len(1).unwrap();
        let unread = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        extra_file
            .set_times(std::fs::FileTimes::new().set_accessed(unread))
            .unwrap();
        paths.push(extra);
        assert!(read_opencode_sources(occurrences(&paths)).is_err());
        assert_eq!(
            extra_file.metadata().unwrap().accessed().unwrap(),
            unread,
            "the extra view must be rejected before reading beyond 64 MiB"
        );
        assert_eq!(std::fs::read_dir(owned.path()).unwrap().count(), 5);
    }

    fn digest(path: &Path) -> String {
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
    }
    #[test]
    fn managed_provider_references_simultaneous_transform_views_preserve_inclusive_capacity() {
        let owned = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        let limit = MAX_SOURCE_VIEW_BYTES as usize;
        let suffix = "{env:VALUE}";
        let document = |tail: &str| {
            format!(
                "{{\"description\":\"{}{tail}\"}}",
                "x".repeat(limit - tail.len() - 18)
            )
        };
        for ordinal in 0..4 {
            let path = owned.path().join(format!("source-{ordinal}.json"));
            let raw = document(if ordinal == 0 { suffix } else { "" });
            assert_eq!(raw.len(), limit);
            assert!(serde_json::from_str::<serde_json::Value>(&raw).is_ok());
            std::fs::write(&path, raw).unwrap();
            paths.push(path);
        }
        let sources = |count: usize| {
            paths[..count]
                .iter()
                .map(|path| SourceOccurrence {
                    logical_path: path.clone(),
                    canonical_source: path.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Workspace,
                })
                .collect()
        };
        let lookup = |_: SourceLane, _: &Path, name: &str| {
            (name == "VALUE").then(|| "x".repeat(suffix.len()))
        };
        let at_capacity = plan_opencode_sources(sources(3), owned.path(), owned.path(), &lookup)
            .expect(
                "48 MiB retained originals plus one complete 16 MiB expansion fits inclusively",
            );
        assert_eq!(at_capacity.len(), 3);
        drop(at_capacity);
        let exhausted = plan_opencode_sources(sources(4), owned.path(), owned.path(), &lookup);
        assert!(
            exhausted.is_err(),
            "64 MiB retained originals cannot allocate another complete expanded source view"
        );
        std::fs::write(&paths[0], document("")).unwrap();
        let no_op = plan_opencode_sources(sources(4), owned.path(), owned.path(), &|_, _, _| None)
            .expect("four distinct no-op 16 MiB sources keep the full inclusive 64 MiB capacity");
        assert_eq!(no_op.len(), 4);
        assert!(no_op.iter().all(|source| std::ptr::eq(
            source.references.template.as_str(),
            source.references.unexpanded_source()
        )));
    }
    #[test]
    fn managed_provider_references_shared_large_source_uses_unique_view_budget() {
        let owned = tempfile::tempdir().unwrap();
        let shared = owned.path().join("shared.json");
        let raw = format!(
            "{{\"agent\":{{\"large\":{{\"description\":\"{}\"}}}}}}",
            "x".repeat(9 * 1024 * 1024)
        );
        std::fs::write(&shared, &raw).unwrap();
        let sources = (0..8)
            .map(|ordinal| SourceOccurrence {
                logical_path: owned.path().join(format!("origin-{ordinal}/opencode.json")),
                canonical_source: shared.clone(),
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            })
            .collect();
        let plan = plan_opencode_sources(sources, owned.path(), owned.path(), &|_, _, _| None)
            .expect(
                "eight native occurrences of one 9 MiB source fit the shared 64 MiB view profile",
            );
        assert_eq!(plan.len(), 8);
        for source in plan {
            assert_eq!(source.references.template.as_str(), raw);
            assert_eq!(source.references.unexpanded_source(), raw);
            assert!(source.original_form && source.references.selections.is_empty());
        }
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

    #[test]
    fn review_r6_local_mcp_command_file_arguments_are_selected() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = owned.path().join("outside-tools");
        let host_command_dir = owned.path().join("host-system-bin");
        let host_command = host_command_dir.join("env");
        let unrelated_host_command = host_command_dir.join("unrelated-tool");
        let absolute_script = tools.join("absolute-mcp.js");
        let relative_script = workspace.join("scripts/relative-mcp.js");
        let env_script = tools.join("env-mcp.js");
        let symlink_target = tools.join("symlink-target.js");
        let workspace_symlink = workspace.join("scripts/symlinked-mcp.js");
        let cwd_script = workspace.join("mcp-cwd/cwd-mcp.js");
        let extensionless_script = tools.join("extensionless-mcp");
        let extensionless_args_script = tools.join("extensionless-with-args");
        let preload_script = tools.join("preload.js");
        let trailing_decoy_script = tools.join("trailing-decoy.js");
        let missing_disabled_script = tools.join("missing-disabled.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&host_command_dir).unwrap();
        std::fs::create_dir_all(relative_script.parent().unwrap()).unwrap();
        std::fs::create_dir_all(cwd_script.parent().unwrap()).unwrap();
        for script in [
            &absolute_script,
            &host_command,
            &unrelated_host_command,
            &relative_script,
            &env_script,
            &symlink_target,
            &cwd_script,
            &extensionless_script,
            &extensionless_args_script,
            &preload_script,
            &trailing_decoy_script,
        ] {
            std::fs::write(script, "process.stdout.write('mcp fixture')\n").unwrap();
        }
        std::fs::write(&host_command, "#!/bin/sh\nprintf 'mcp fixture\\n'\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&host_command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        let direct_command = loop {
            let result = std::process::Command::new(&host_command).output();
            if result
                .as_ref()
                .is_err_and(|error| error.raw_os_error() == Some(libc::ETXTBSY))
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            break result;
        };
        assert!(
            direct_command
                .as_ref()
                .is_ok_and(|output| output.status.success() && output.stdout == b"mcp fixture\n"),
            "the absolute MCP executable fixture must actually start: {direct_command:?}"
        );
        std::os::unix::fs::symlink(&symlink_target, &workspace_symlink).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "absolute": {
                        "type": "local",
                        "command": ["node", absolute_script],
                        "enabled": true,
                    },
                    "absolute-runtime": {
                        "type": "local",
                        "command": [host_command],
                        "enabled": true,
                    },
                    "relative": {
                        "type": "local",
                        "command": ["node", "scripts/relative-mcp.js"],
                        "enabled": true,
                    },
                    "workspace-symlink": {
                        "type": "local",
                        "command": ["node", "scripts/symlinked-mcp.js"],
                        "enabled": true,
                    },
                    "env": {
                        "type": "local",
                        "command": ["node", "{env:MCP_SERVER_PATH}"],
                        "enabled": true,
                    },
                    "cwd": {
                        "type": "local",
                        "cwd": "mcp-cwd",
                        "command": ["node", "cwd-mcp.js"],
                        "enabled": true,
                    },
                    "extensionless": {
                        "type": "local",
                        "command": ["node", extensionless_script],
                        "enabled": true,
                    },
                    "extensionless-with-trailing-options": {
                        "type": "local",
                        "command": ["node", extensionless_args_script, "--config", "prod"],
                        "enabled": true,
                    },
                    "extensionless-after-runtime-option": {
                        "type": "local",
                        "command": ["node", "--require", preload_script, extensionless_args_script, "--config", trailing_decoy_script],
                        "enabled": true,
                    },
                    "package": {
                        "type": "local",
                        "command": ["npx", "-y", "@example/mcp-server"],
                        "enabled": true,
                    },
                    "disabled": {
                        "type": "local",
                        "command": ["node", missing_disabled_script],
                        "enabled": false,
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, name| {
                (name == "MCP_SERVER_PATH").then(|| env_script.to_string_lossy().into_owned())
            },
        )
        .unwrap();
        let selected = &plan[0].configured_resources;

        for script in [
            &absolute_script,
            &relative_script,
            &symlink_target,
            &env_script,
            &extensionless_script,
            &extensionless_args_script,
            &preload_script,
        ] {
            let canonical_script = script.canonicalize().unwrap();
            assert!(
                selected.iter().any(|resource| {
                    resource == &canonical_script
                        || (resource.is_dir() && canonical_script.starts_with(resource))
                }),
                "enabled local MCP command script must be available through its selected resource: {}",
                script.display()
            );
        }
        assert!(
            selected.contains(&host_command.canonicalize().unwrap()),
            "an absolute MCP runtime executable remains available to the managed child"
        );
        assert!(
            !selected.contains(&host_command_dir.canonicalize().unwrap()),
            "an absolute system executable must not select its unbounded containing directory"
        );
        assert!(
            !selected.contains(&unrelated_host_command.canonicalize().unwrap()),
            "an absolute system executable must not copy unrelated sibling commands"
        );
        assert!(
            !selected.contains(&trailing_decoy_script.canonicalize().unwrap()),
            "arguments after the selected script are values, not additional scripts"
        );
        assert!(
            selected.contains(&cwd_script.parent().unwrap().canonicalize().unwrap()),
            "the selected local MCP cwd carries scripts below it"
        );
        assert!(
            !selected.contains(&cwd_script.canonicalize().unwrap()),
            "scripts already carried by the selected cwd do not get overlapping mounts"
        );
        assert!(!selected.contains(&missing_disabled_script));
        assert!(
            plan[0]
                .references
                .path_variables
                .contains(&"MCP_SERVER_PATH".to_string()),
            "command path environment references are resolved through the planned source"
        );
    }

    #[test]
    fn review_r7_bun_package_script_is_not_mistaken_for_a_file_path() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let package = owned.path().join("outside-mcp-package");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"scripts":{"mcp":"node ./server.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("server.js"), "process.exit(0)\n").unwrap();

        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "package-script": {
                        "type": "local",
                        "cwd": package,
                        "command": ["bun", "run", "mcp"],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .expect("bun run <package-script> is a command, not a path to copy");

        let selected = &plan[0].configured_resources;
        assert!(selected.contains(&package.canonicalize().unwrap()));
        assert!(package.join("package.json").is_file());
        assert!(package.join("server.js").is_file());
        assert!(!selected.contains(&workspace.join("mcp")));
    }

    #[test]
    fn review_r8_bun_package_script_name_with_extension_uses_nearest_manifest() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let package = owned.path().join("outside-mcp-package");
        let nested = package.join("nested");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"scripts":{"mcp.js":"node ./server.js"}}"#,
        )
        .unwrap();
        std::fs::write(package.join("server.js"), "process.exit(0)\n").unwrap();

        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "package-script": {
                        "type": "local",
                        "cwd": nested,
                        "command": ["bun", "run", "mcp.js"],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .expect("bun run gives the matching package script precedence over a same-named file");

        assert!(plan[0]
            .configured_resources
            .contains(&package.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&nested.canonicalize().unwrap()));
        assert!(package.join("package.json").is_file());
        assert!(package.join("server.js").is_file());
        assert!(!package.join("mcp.js").exists());
    }

    #[test]
    fn bun_run_bare_script_file_remains_a_resource_without_matching_package_script() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("package.json"), r#"{"scripts":{}}"#).unwrap();
        std::fs::write(workspace.join("mcp.js"), "process.exit(0)\n").unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "file-command": {
                        "type": "local",
                        "command": ["bun", "run", "mcp.js"],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .expect("without a matching package script, a bare Bun file operand remains selectable");

        assert!(
            plan[0]
                .configured_resources
                .contains(&workspace.join("mcp.js").canonicalize().unwrap()),
            "selected Bun script resources were {:?}",
            plan[0].configured_resources
        );
        assert!(plan[0]
            .configured_resources
            .contains(&workspace.join("package.json").canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&workspace.canonicalize().unwrap()));
    }

    #[test]
    fn bun_run_explicit_relative_file_wins_over_same_named_package_script() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            workspace.join("package.json"),
            r#"{"scripts":{"mcp.js":"echo package-script"}}"#,
        )
        .unwrap();
        std::fs::write(workspace.join("mcp.js"), "process.exit(0)\n").unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "file-command": {
                        "type": "local",
                        "command": ["bun", "run", "./mcp.js"],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .expect("Bun treats an explicit ./ operand as a source file");

        assert!(
            plan[0]
                .configured_resources
                .contains(&workspace.join("mcp.js").canonicalize().unwrap()),
            "selected Bun script resources were {:?}",
            plan[0].configured_resources
        );
        assert!(plan[0]
            .configured_resources
            .contains(&workspace.join("package.json").canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&workspace.canonicalize().unwrap()));
    }

    #[test]
    fn freshell_image_mcp_command_is_not_selected_as_a_host_resource() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let local_script = external.join("user-mcp.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(&local_script, "process.stdout.write('user mcp')\n").unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "freshell": {
                        "type": "local",
                        "command": ["node", "/opt/freshell-mcp/server.js"],
                    },
                    "user": {
                        "type": "local",
                        "command": ["node", local_script],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .expect("the image-provided Freshell MCP is not a host path reference");

        assert!(plan[0]
            .configured_resources
            .contains(&external.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .iter()
            .any(|path| path.starts_with("/opt/freshell-mcp")
                || path == Path::new("/opt/package.json")));
    }

    #[test]
    fn generated_project_freshell_mcp_is_not_selected_but_user_replacement_is() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let launch_cwd = workspace.join("packages/app");
        let checkout = owned.path().join("freshell-checkout");
        let config = workspace.join(".opencode/opencode.json");
        let state = workspace.join(".opencode/.freshell-mcp-state.json");
        let loader = checkout.join("node_modules/tsx/dist/loader.mjs");
        let server = checkout.join("tools/freshell-mcp/server.ts");
        let user_root = owned.path().join("user-mcp");
        let user_script = user_root.join("server.mjs");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&launch_cwd).unwrap();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::create_dir_all(loader.parent().unwrap()).unwrap();
        std::fs::create_dir_all(server.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&user_root).unwrap();
        std::fs::write(
            checkout.join("package.json"),
            r#"{"name":"freshell","type":"module"}"#,
        )
        .unwrap();
        std::fs::write(&loader, "export {}\n").unwrap();
        std::fs::write(&server, "export {}\n").unwrap();
        std::fs::write(&user_script, "export {}\n").unwrap();
        let owned_command = serde_json::json!([
            "node",
            "--import",
            loader.to_string_lossy(),
            server.to_string_lossy()
        ]);
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {"freshell": {"type": "local", "command": owned_command}}
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            &state,
            serde_json::json!({"createdEntry": true, "ownedCommand": owned_command}).to_string(),
        )
        .unwrap();

        let plan_for = || {
            plan_opencode_sources(
                vec![SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Workspace,
                }],
                &launch_cwd,
                &home,
                &|_, _, _| None,
            )
            .unwrap()
        };

        let generated = plan_for();
        assert!(
            !generated[0]
                .configured_resources
                .iter()
                .any(|path| path.starts_with(&checkout)),
            "managed OpenCode already provides Freshell MCP from its runtime image"
        );

        let user_command = serde_json::json!(["node", user_script]);
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {"freshell": {"type": "local", "command": user_command}}
            })
            .to_string(),
        )
        .unwrap();
        let replaced = plan_for();
        let canonical_user_root = user_root.canonicalize().unwrap();
        assert!(replaced[0]
            .configured_resources
            .iter()
            .any(|path| path == &canonical_user_root || path.starts_with(&canonical_user_root)));
    }
}
