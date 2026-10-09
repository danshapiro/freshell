//! Native local Amplifier resource selection. Commands and unrelated YAML
//! retain their original bytes; only selected source scalar nodes are rewritten.
use freshell_platform::provider_environment::CopySelection;
use saphyr::{LoadableYamlNode, MarkedYamlOwned};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) struct ResourcePreparation {
    pub selections: Vec<CopySelection>,
    pub rewritten_settings: Option<String>,
    pub rewritten_resources: Vec<(PathBuf, String)>,
}

pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    excluded: &[PathBuf],
) -> Result<ResourcePreparation, String> {
    let path = home.join(".amplifier/settings.yaml");
    let mut result = ResourcePreparation {
        selections: Vec::new(),
        rewritten_settings: None,
        rewritten_resources: Vec::new(),
    };
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(_) => return Err("Amplifier selected settings source unreadable".into()),
    };
    let mut raw = String::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "Amplifier selected settings source unreadable or not UTF-8")?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err("Amplifier selected settings source exceeds 16 MiB".into());
    }
    bound_yaml_expansion(&raw)?;
    let documents = MarkedYamlOwned::load_from_str(&raw)
        .map_err(|_| "Amplifier selected settings YAML is invalid")?;
    if documents.len() > 1 {
        return Err("Amplifier selected settings must contain one YAML document".into());
    }
    let Some(document) = documents.first() else {
        return Ok(result);
    };
    let Some(bundle) = native_mapping_value(document, "bundle", 0)? else {
        return Ok(result);
    };
    let Some(active) = native_mapping_value(bundle, "active", 0)? else {
        return Ok(result);
    };
    let Some(source) = active.data.as_str() else {
        return Err("Amplifier bundle.active source has an unsupported type".into());
    };
    let mut state = BundleSelection {
        view_bytes: raw.len(),
        ..Default::default()
    };
    if let Some(runtime) = select_local_bundle(source, cwd, excluded, &mut result, &mut state)? {
        let replacement = serde_json::to_string(&runtime)
            .map_err(|_| "Amplifier projected source could not be encoded")?;
        select_namespace_contexts(excluded, &mut result, &mut state)?;
        result.rewritten_settings = Some(rewrite_bundle_active(
            &raw,
            document,
            bundle,
            active,
            &replacement,
        )?);
    }
    Ok(result)
}

#[derive(Default)]
struct BundleSelection {
    next_id: usize,
    active: std::collections::BTreeSet<PathBuf>,
    view_bytes: usize,
    metadata_bytes: usize,
    completed: BTreeMap<PathBuf, String>,
    modules: BTreeMap<PathBuf, String>,
    namespaces: BTreeMap<String, (PathBuf, PathBuf)>,
    bundle_names: BTreeMap<PathBuf, String>,
    pending_contexts: Vec<(String, PathBuf)>,
    native_includes: bool,
}

impl BundleSelection {
    fn remember_namespace(
        &mut self,
        name: &str,
        source: &Path,
        destination: &Path,
    ) -> Result<(), String> {
        if self.namespaces.contains_key(name) {
            return Ok(());
        }
        if self.namespaces.len() >= 8192 {
            return Err("Amplifier namespace event budget exceeded".into());
        }
        self.retain_metadata(name.len())?;
        self.retain_metadata(source.as_os_str().len())?;
        self.retain_metadata(destination.as_os_str().len())?;
        self.namespaces
            .insert(name.into(), (source.to_owned(), destination.to_owned()));
        Ok(())
    }

    fn remember_bundle_name(&mut self, root: &Path, name: &str) -> Result<(), String> {
        if !self.bundle_names.contains_key(root) {
            if self.bundle_names.len() >= 8192 {
                return Err("Amplifier namespace event budget exceeded".into());
            }
            self.retain_metadata(root.as_os_str().len())?;
            self.retain_metadata(name.len())?;
            self.bundle_names.insert(root.to_owned(), name.to_owned());
        }
        Ok(())
    }

    fn retain_metadata(&mut self, bytes: usize) -> Result<(), String> {
        self.metadata_bytes = self
            .metadata_bytes
            .checked_add(bytes)
            .ok_or("Amplifier selected source metadata overflow")?;
        if self.metadata_bytes > 8 * 1024 * 1024 {
            return Err("Amplifier selected source metadata budget exceeded".into());
        }
        Ok(())
    }
}

fn select_namespace_contexts(
    excluded: &[PathBuf],
    result: &mut ResourcePreparation,
    state: &mut BundleSelection,
) -> Result<(), String> {
    for (namespace, path) in &state.pending_contexts {
        let Some((source_base, destination_base)) = state.namespaces.get(namespace) else {
            if state.native_includes {
                continue;
            } // Remote/registered bundles retain native resolution.
            return Err("Amplifier selected context namespace has no local source base".into());
        };
        let selected = source_base.join(path);
        let canonical = std::fs::canonicalize(&selected)
            .map_err(|_| "Amplifier selected context is missing, inaccessible or cyclic")?;
        if excluded.iter().any(|path| canonical.starts_with(path)) {
            return Err("Amplifier selected context aliases credentials or native state; use the approved private grant source".into());
        }
        if !canonical.is_file() {
            return Err("Amplifier selected context is not a regular file".into());
        }
        std::fs::File::open(&canonical).map_err(|_| "Amplifier selected context is unreadable")?;
        let destination = destination_base.join(path);
        if let Some(existing) = result
            .selections
            .iter()
            .find(|selection| selection.destination_relative == destination)
        {
            if std::fs::canonicalize(&existing.source).ok().as_ref() != Some(&canonical) {
                return Err("Amplifier selected namespace context destination conflicts".into());
            }
            continue;
        }
        if result.selections.len() >= 8192 {
            return Err("Amplifier source selection event budget exceeded".into());
        }
        result.selections.push(CopySelection {
            source: selected,
            destination_relative: destination,
        });
    }
    Ok(())
}
// FileSourceHandler first finds the nearest native bundle entry starting at
// base_path. An entry in base_path is the source boundary, so the registry's
// ancestor search cannot select its parent. Otherwise the nearest ancestor is
// the finite local ROOT. Its registration and the child override are separate.
fn native_ancestor_root(
    root: &Path,
    excluded: &[PathBuf],
    state: &mut BundleSelection,
) -> Result<Option<(PathBuf, String)>, String> {
    for (depth, directory) in root.ancestors().enumerate() {
        if depth >= 64 {
            return Err("Amplifier local ancestor depth profile exceeded".into());
        }
        for leaf in ["bundle.md", "bundle.yaml"] {
            let path = directory.join(leaf);
            match std::fs::metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Amplifier ancestor bundle metadata unavailable".into()),
                Ok(_) if directory == root => return Ok(None),
                Ok(metadata) if !metadata.is_file() => {
                    return Err("Amplifier ancestor bundle is not a regular file".into())
                }
                Ok(_) => {}
            }
            let canonical = std::fs::canonicalize(&path)
                .map_err(|_| "Amplifier ancestor bundle unavailable or cyclic")?;
            if let Some(ancestor_name) = state.bundle_names.get(&canonical) {
                return Ok(Some((directory.to_owned(), ancestor_name.clone())));
            }
            if excluded.iter().any(|path| canonical.starts_with(path)) {
                return Err("Amplifier ancestor bundle aliases credentials or native state".into());
            }
            let limit = (64 * 1024 * 1024usize)
                .checked_sub(state.view_bytes)
                .ok_or("Amplifier retained source view size overflow")?
                .min(16 * 1024 * 1024);
            let mut raw = String::new();
            std::fs::File::open(&canonical)
                .map_err(|_| "Amplifier ancestor bundle unreadable")?
                .take(limit as u64 + 1)
                .read_to_string(&mut raw)
                .map_err(|_| "Amplifier ancestor bundle unreadable or not UTF-8")?;
            if raw.len() > limit {
                return Err("Amplifier ancestor bundle exceeds shared source-view profile".into());
            }
            state.view_bytes = state
                .view_bytes
                .checked_add(raw.len())
                .ok_or("Amplifier retained source view size overflow")?;
            let yaml = if leaf == "bundle.md" {
                markdown_frontmatter(&raw).map(|(yaml, _)| yaml)
            } else {
                Some(raw.as_str())
            };
            let Some(yaml) = yaml else {
                return Ok(None);
            };
            bound_yaml_expansion(yaml)?;
            let documents = MarkedYamlOwned::load_from_str(yaml)
                .map_err(|_| "Amplifier ancestor bundle YAML is invalid")?;
            if documents.len() != 1 {
                return Err("Amplifier ancestor bundle requires one YAML document".into());
            }
            let ancestor_name = native_mapping_value(&documents[0], "bundle", 0)?
                .map(|meta| native_mapping_value(meta, "name", 0))
                .transpose()?
                .flatten()
                .and_then(|node| node.data.as_str())
                .unwrap_or("");
            state.remember_bundle_name(&canonical, ancestor_name)?;
            return Ok(Some((directory.to_owned(), ancestor_name.to_owned())));
        }
    }
    Ok(None)
}

fn select_local_bundle(
    source: &str,
    cwd: &Path,
    excluded: &[PathBuf],
    result: &mut ResourcePreparation,
    state: &mut BundleSelection,
) -> Result<Option<String>, String> {
    let local = if let Some(local) = source.strip_prefix("file://") {
        local
    } else if source.starts_with("./")
        || source.starts_with("../")
        || Path::new(source).is_absolute()
    {
        source
    } else {
        return Ok(None);
    };
    if local.is_empty() || local.chars().any(char::is_control) {
        return Err("Amplifier local source has an invalid path".into());
    }
    let selected = PathBuf::from(local);
    let selected = if selected.is_absolute() {
        selected
    } else {
        cwd.join(selected)
    };
    let canonical = std::fs::canonicalize(&selected)
        .map_err(|_| "Amplifier selected local bundle is missing, inaccessible or cyclic")?;
    if excluded.iter().any(|path| canonical.starts_with(path)) {
        return Err("Amplifier selected bundle aliases credentials or native state; use the approved private grant source".into());
    }
    if let Some(runtime) = state.completed.get(&canonical) {
        return Ok(Some(runtime.clone()));
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "Amplifier selected local bundle metadata unavailable")?;
    let (root, leaf) = if metadata.is_file() {
        (
            canonical
                .parent()
                .ok_or("Amplifier selected local bundle parent unavailable")?
                .to_owned(),
            canonical
                .file_name()
                .ok_or("Amplifier selected local bundle filename unavailable")?
                .to_owned(),
        )
    } else if metadata.is_dir() {
        (canonical.clone(), std::ffi::OsString::new())
    } else {
        return Err("Amplifier selected local bundle has an unsupported filesystem type".into());
    };
    if state.active.contains(&canonical) {
        return Err("Amplifier local include cycle detected".into());
    }
    if state.active.len() >= 64 || state.next_id >= 8192 {
        return Err("Amplifier local include depth or event budget exceeded".into());
    }
    state.retain_metadata(canonical.as_os_str().len())?;
    state.active.insert(canonical.clone());
    let id = state.next_id;
    state.next_id += 1;
    let relative = PathBuf::from(format!(".freshell/resources/amplifier-local-{id}"));
    let runtime = Path::new("/home/freshell/provider")
        .join(&relative)
        .join(leaf);
    let runtime = runtime
        .to_str()
        .ok_or("Amplifier projected bundle path is not UTF-8")?;
    let runtime_uri = format!("file://{runtime}");
    let document_path = if metadata.is_dir() {
        result.selections.push(CopySelection {
            source: root.clone(),
            destination_relative: relative.clone(),
        });
        let mut entry = None;
        for name in ["bundle.md", "bundle.yaml"] {
            let candidate = root.join(name);
            match std::fs::symlink_metadata(&candidate) {
                Ok(_) => {
                    entry = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err("Amplifier directory bundle entry metadata unavailable".into())
                }
            }
        }
        entry.ok_or("Amplifier selected directory has no native bundle entry")?
    } else {
        canonical.clone()
    };
    let document = std::fs::canonicalize(&document_path)
        .map_err(|_| "Amplifier directory bundle entry unavailable, dangling or cyclic")?;
    if excluded.iter().any(|path| document.starts_with(path)) {
        return Err("Amplifier selected bundle entry aliases credentials or native state; use the approved private grant source".into());
    }
    let document_relative = relative.join(
        document_path
            .file_name()
            .ok_or("Amplifier bundle filename unavailable")?,
    );
    let root = document
        .parent()
        .ok_or("Amplifier bundle parent unavailable")?;
    {
        // A standalone bundle document does not select its entire parent
        // directory. Preserve only its finite resources and native package
        // closure; selecting a document in HOME must not copy HOME wholesale.
        if !document
            .extension()
            .is_some_and(|extension| extension == "yaml" || extension == "yml" || extension == "md")
        {
            return Err("Amplifier local bundle source has an unsupported native format".into());
        }
        if metadata.is_file() {
            result.selections.push(CopySelection {
                source: document.clone(),
                destination_relative: document_relative.clone(),
            });
        }
        let mut bundle_raw = String::new();
        let remaining = (64 * 1024 * 1024usize)
            .checked_sub(state.view_bytes)
            .ok_or("Amplifier retained source view size overflow")?;
        let limit = remaining.min(16 * 1024 * 1024);
        std::fs::File::open(&document)
            .map_err(|_| "Amplifier selected bundle unreadable")?
            .take(limit as u64 + 1)
            .read_to_string(&mut bundle_raw)
            .map_err(|_| "Amplifier selected bundle is unreadable or not UTF-8")?;
        if bundle_raw.len() > limit {
            return Err("Amplifier selected bundle exceeds the shared source-view profile".into());
        }
        state.view_bytes = state
            .view_bytes
            .checked_add(bundle_raw.len())
            .ok_or("Amplifier retained source view size overflow")?;
        let yaml = if document
            .extension()
            .is_some_and(|extension| extension == "md")
        {
            markdown_frontmatter(&bundle_raw)
        } else {
            Some((bundle_raw.as_str(), 0))
        };
        if let Some((yaml, header_offset)) = yaml {
            bound_yaml_expansion(yaml)?;
            let bundle_documents = MarkedYamlOwned::load_from_str(yaml)
                .map_err(|_| "Amplifier selected bundle YAML is invalid")?;
            if bundle_documents.len() != 1 {
                return Err("Amplifier selected bundle requires one YAML document".into());
            }
            let mut bundle_replacements = Vec::new();
            if let Some(meta) = native_mapping_value(&bundle_documents[0], "bundle", 0)? {
                if let Some(name) = native_mapping_value(meta, "name", 0)?
                    .and_then(|node| node.data.as_str())
                    .filter(|name| !name.is_empty())
                {
                    let namespace_root = native_mapping_value(meta, "namespace_root", 0)?
                        .filter(|node| !node.data.is_null());
                    state.remember_bundle_name(&document, name)?;
                    let ancestor = native_ancestor_root(root, excluded, state)?;
                    // A named ROOT registers source_root even when its name
                    // equals the selected child. An unnamed ROOT still permits
                    // the different-named child's namespace_root override.
                    if let Some((source_root, root_name)) = &ancestor {
                        if !root_name.is_empty() {
                            state.remember_namespace(root_name, source_root, &relative)?;
                        }
                    }
                    let namespace_root = namespace_root.filter(|_| {
                        ancestor
                            .as_ref()
                            .is_some_and(|(_, root_name)| root_name != name)
                    });
                    let source_base = if let Some(node) = namespace_root {
                        let relative = node
                            .data
                            .as_str()
                            .ok_or("Amplifier namespace_root must be a string")?;
                        let selected = root.join(relative);
                        let canonical = std::fs::canonicalize(&selected).map_err(|_| {
                            "Amplifier namespace source base is unavailable or cyclic"
                        })?;
                        if !canonical.is_dir() {
                            return Err("Amplifier namespace source base is not a directory".into());
                        }
                        let start = header_offset
                            .checked_add(source_offset(yaml, node.span.start)?)
                            .ok_or("Amplifier namespace source offset overflow")?;
                        let end = header_offset
                            .checked_add(source_offset(yaml, node.span.end)?)
                            .ok_or("Amplifier namespace source offset overflow")?;
                        // Each selected namespace is relocated into its bundle's
                        // projected resource root; keep its native include names.
                        bundle_replacements.push((start, end, "\".\"".into()));
                        canonical
                    } else {
                        root.to_owned()
                    };
                    state.remember_namespace(name, &source_base, &relative)?;
                }
            }
            let module_origin = ModuleSourceOrigin {
                yaml,
                header_offset,
                declaring_root: root,
                bundle_destination: &relative,
                complete_bundle_directory: metadata.is_dir(),
                excluded,
            };
            if let Some(session) = native_mapping_value(&bundle_documents[0], "session", 0)? {
                for kind in ["orchestrator", "context"] {
                    if let Some(module) = native_mapping_value(session, kind, 0)? {
                        project_module_source(
                            module,
                            &module_origin,
                            result,
                            state,
                            &mut bundle_replacements,
                        )?;
                    }
                }
            }
            for kind in ["providers", "tools", "hooks"] {
                if let Some(modules) = native_mapping_value(&bundle_documents[0], kind, 0)? {
                    for module in modules
                        .data
                        .as_sequence()
                        .ok_or("Amplifier selected module list must be a sequence")?
                    {
                        project_module_source(
                            module,
                            &module_origin,
                            result,
                            state,
                            &mut bundle_replacements,
                        )?;
                    }
                }
            }
            if let Some(includes) = bundle_documents[0].data.as_mapping_get("includes") {
                for item in includes
                    .data
                    .as_sequence()
                    .ok_or("Amplifier includes must be a sequence")?
                {
                    let node = if item.data.as_str().is_some() {
                        item
                    } else {
                        item.data
                            .as_mapping_get("bundle")
                            .ok_or("Amplifier include requires its bundle source")?
                    };
                    let source = node
                        .data
                        .as_str()
                        .ok_or("Amplifier include bundle source must be a string")?;
                    if let Some(projected) =
                        select_local_bundle(source, cwd, excluded, result, state)?
                    {
                        let replacement = serde_json::to_string(&projected)
                            .map_err(|_| "Amplifier include source could not be encoded")?;
                        let start = header_offset
                            .checked_add(source_offset(yaml, node.span.start)?)
                            .ok_or("Amplifier include source offset overflow")?;
                        let end = header_offset
                            .checked_add(source_offset(yaml, node.span.end)?)
                            .ok_or("Amplifier include source offset overflow")?;
                        bundle_replacements.push((start, end, replacement));
                    } else {
                        state.native_includes = true;
                    }
                }
            }
            if let Some(context) = bundle_documents[0]
                .data
                .as_mapping_get("context")
                .and_then(|node| node.data.as_mapping())
            {
                for (name, node) in context {
                    let include = name.data.as_str() == Some("include");
                    let entries = if include {
                        node.data
                            .as_sequence()
                            .ok_or("Amplifier context.include must be a sequence")?
                            .as_slice()
                    } else {
                        std::slice::from_ref(node)
                    };
                    for node in entries {
                        let Some(value) = node.data.as_str() else {
                            continue;
                        };
                        let value = if include {
                            value.trim_start_matches('/')
                        } else {
                            value
                        };
                        if include {
                            if let Some((namespace, path)) = value.split_once(':') {
                                state.retain_metadata(value.len())?;
                                let path = PathBuf::from(path.trim_start_matches('/'));
                                if namespace.is_empty()
                                    || path.as_os_str().is_empty()
                                    || path.components().any(|component| {
                                        !matches!(
                                            component,
                                            std::path::Component::Normal(_)
                                                | std::path::Component::CurDir
                                        )
                                    })
                                {
                                    return Err(
                                        "Amplifier selected namespace context path is unsupported"
                                            .into(),
                                    );
                                }
                                if state.pending_contexts.len() >= 8192 {
                                    return Err(
                                        "Amplifier namespace context event budget exceeded".into(),
                                    );
                                }
                                state.pending_contexts.push((namespace.into(), path));
                                continue;
                            }
                        }
                        let path = Path::new(value);
                        let selected = if path.is_absolute() {
                            path.to_owned()
                        } else {
                            root.join(path)
                        };
                        let independent = path.is_absolute()
                            || path.components().any(|component| {
                                matches!(component, std::path::Component::ParentDir)
                            });
                        if include && independent {
                            return Err("Amplifier context.include outside its source base requires an independent namespace projection".into());
                        }
                        let destination = if independent {
                            PathBuf::from(format!(
                                ".freshell/resources/amplifier-context-{}",
                                result.selections.len()
                            ))
                        } else {
                            relative.join(path)
                        };
                        if independent {
                            let runtime = Path::new("/home/freshell/provider").join(&destination);
                            let replacement = serde_json::to_string(
                                runtime
                                    .to_str()
                                    .ok_or("Amplifier context destination is not UTF-8")?,
                            )
                            .map_err(|_| "Amplifier context destination could not be encoded")?;
                            let start = header_offset
                                .checked_add(source_offset(yaml, node.span.start)?)
                                .ok_or("Amplifier Markdown source offset overflow")?;
                            let end = header_offset
                                .checked_add(source_offset(yaml, node.span.end)?)
                                .ok_or("Amplifier Markdown source offset overflow")?;
                            bundle_replacements.push((start, end, replacement));
                        }
                        if result.selections.len() >= 8192 {
                            return Err("Amplifier source selection event budget exceeded".into());
                        }
                        let canonical_context = std::fs::canonicalize(&selected).map_err(|_| {
                            "Amplifier selected context is missing, inaccessible or cyclic"
                        })?;
                        if excluded
                            .iter()
                            .any(|path| canonical_context.starts_with(path))
                        {
                            return Err("Amplifier selected context aliases credentials or native state; use the approved private grant source".into());
                        }
                        result.selections.push(CopySelection {
                            source: selected,
                            destination_relative: destination,
                        });
                    }
                }
            }
            {
                let mut template = bundle_raw;
                bundle_replacements.sort_by_key(|(start, _, _)| *start);
                for (start, end, replacement) in bundle_replacements.into_iter().rev() {
                    if start > end
                        || end > template.len()
                        || template
                            .len()
                            .checked_sub(end - start)
                            .and_then(|size| size.checked_add(replacement.len()))
                            .is_none_or(|size| size > 16 * 1024 * 1024)
                    {
                        return Err(
                            "Amplifier bundle source rewrite exceeds its source-view profile"
                                .into(),
                        );
                    }
                    template.replace_range(start..end, &replacement);
                }
                result
                    .rewritten_resources
                    .push((document_relative, template));
            }
        }
    }
    state.active.remove(&canonical);
    state.completed.insert(canonical, runtime_uri.clone());
    Ok(Some(runtime_uri))
}

#[derive(Clone, Copy)]
struct ModuleSourceOrigin<'a> {
    yaml: &'a str,
    header_offset: usize,
    declaring_root: &'a Path,
    bundle_destination: &'a Path,
    complete_bundle_directory: bool,
    excluded: &'a [PathBuf],
}

fn project_module_source(
    module: &MarkedYamlOwned,
    origin: &ModuleSourceOrigin<'_>,
    result: &mut ResourcePreparation,
    state: &mut BundleSelection,
    replacements: &mut Vec<(usize, usize, String)>,
) -> Result<(), String> {
    let ModuleSourceOrigin {
        yaml,
        header_offset,
        declaring_root,
        bundle_destination,
        complete_bundle_directory,
        excluded,
    } = *origin;
    let Some(node) = native_mapping_value(module, "source", 0)? else {
        return Ok(());
    };
    let Some(source) = node.data.as_str() else {
        return Ok(());
    };
    let local = if let Some(path) = source.strip_prefix("file://") {
        path
    } else if source.starts_with("./")
        || source.starts_with("../")
        || Path::new(source).is_absolute()
    {
        source
    } else {
        return Ok(());
    };
    if local.is_empty() || local.len() > 64 * 1024 || local.chars().any(char::is_control) {
        return Err("Amplifier selected module source path is invalid".into());
    }
    let selected = if Path::new(local).is_absolute() {
        PathBuf::from(local)
    } else {
        declaring_root.join(local)
    };
    let canonical = std::fs::canonicalize(&selected).map_err(|error| {
        format!(
            "Amplifier selected module source {} is unavailable: {error}",
            selected.display()
        )
    })?;
    if excluded.iter().any(|path| canonical.starts_with(path)) {
        return Err("Amplifier selected module aliases credentials or native state; use the approved private grant source".into());
    }
    if !std::fs::metadata(&canonical)
        .map_err(|error| format!("Amplifier selected module source metadata failed: {error}"))?
        .is_dir()
    {
        return Err(
            "Amplifier selected local module source must be a complete package directory".into(),
        );
    }
    let runtime = if let Some(runtime) = state.modules.get(&canonical) {
        runtime.clone()
    } else {
        if state.next_id >= 8192 {
            return Err("Amplifier selected module event budget exceeded".into());
        }
        state.metadata_bytes = state
            .metadata_bytes
            .checked_add(canonical.as_os_str().len())
            .and_then(|size| size.checked_add(selected.as_os_str().len()))
            .ok_or("Amplifier selected module metadata size overflow")?;
        if state.metadata_bytes > 8 * 1024 * 1024 {
            return Err("Amplifier selected module metadata budget exceeded".into());
        }
        let destination = if complete_bundle_directory && canonical.starts_with(declaring_root) {
            bundle_destination.join(canonical.strip_prefix(declaring_root).unwrap())
        } else {
            let destination = PathBuf::from(format!(
                ".freshell/resources/amplifier-module-{}",
                state.next_id
            ));
            result.selections.push(CopySelection {
                source: canonical.clone(),
                destination_relative: destination.clone(),
            });
            destination
        };
        state.next_id += 1;
        let runtime = format!(
            "file://{}",
            Path::new("/home/freshell/provider")
                .join(destination)
                .to_str()
                .ok_or("Amplifier projected module path is not UTF-8")?
        );
        state.modules.insert(canonical, runtime.clone());
        runtime
    };
    let start = header_offset
        .checked_add(source_offset(yaml, node.span.start)?)
        .ok_or("Amplifier module source offset overflow")?;
    let end = header_offset
        .checked_add(source_offset(yaml, node.span.end)?)
        .ok_or("Amplifier module source offset overflow")?;
    replacements.push((
        start,
        end,
        serde_json::to_string(&runtime).map_err(|_| "Amplifier module source cannot be encoded")?,
    ));
    Ok(())
}

fn markdown_frontmatter(raw: &str) -> Option<(&str, usize)> {
    static HEADER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let expression = HEADER.get_or_init(|| {
        regex::Regex::new(r"(?s)\A---\s*\n(.*?)\n---\s*\n?")
            .expect("fixed native Markdown frontmatter expression")
    });
    let header = expression.captures(raw)?.get(1)?;
    Some((header.as_str(), header.start()))
}

#[cfg(test)]
mod module_source_tests {
    use super::*;

    #[test]
    fn managed_provider_amplifier_namespace_context_consumes_native_source_bases_after_both_copies()
    {
        for scenario in ["self", "self-null", "self-override", "nested"] {
            let nested = scenario == "nested";
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let cwd = owned.path().join("workspace");
            let bundle = owned.path().join("external-bundle");
            for path in [
                &home.join(".amplifier"),
                &cwd,
                &bundle.join("behaviors"),
                &bundle.join("context"),
            ] {
                std::fs::create_dir_all(path).unwrap();
            }
            let child = bundle.join("behaviors/probe.yaml");
            let raw_child="bundle: {name: probe, namespace_root: ..}\ncontext:\n  include: ['probe:context/selected.md']\n";
            let raw = if nested {
                format!("bundle: {{name: root}}\nincludes: [{}]\ncontext:\n  include: ['probe:context/selected.md']\n",serde_json::to_string(&format!("file://{}",child.display())).unwrap())
            } else {
                format!("bundle: {{name: probe{}}}\ncontext:\n  include: ['probe:context/selected.md']\n",if scenario=="self-null" {", namespace_root: null"} else if scenario=="self-override" {", namespace_root: .."} else {""})
            };
            std::fs::write(bundle.join("bundle.yaml"), &raw).unwrap();
            std::fs::write(&child, raw_child).unwrap();
            std::fs::write(
                bundle.join("context/selected.md"),
                "selected-namespaced-context",
            )
            .unwrap();
            std::fs::create_dir_all(owned.path().join("context")).unwrap();
            std::fs::write(
                owned.path().join("context/selected.md"),
                "wrong-parent-decoy",
            )
            .unwrap();
            let settings = home.join(".amplifier/settings.yaml");
            let raw_settings = format!(
                "bundle: {{active: {}}}\n",
                serde_json::to_string(&format!("file://{}", bundle.join("bundle.yaml").display()))
                    .unwrap()
            );
            std::fs::write(&settings, &raw_settings).unwrap();
            let prepared =
                prepare(&home, &cwd, &[]).expect("native local namespace context must prepare");
            let stage = owned.path().join("stage");
            let host = owned.path().join("host");
            freshell_platform::provider_environment::copy_environment(
                &prepared.selections,
                &stage,
                &[],
                Default::default(),
            )
            .unwrap();
            for (relative, raw) in &prepared.rewritten_resources {
                std::fs::write(stage.join(relative), raw).unwrap();
            }
            let selections = prepared
                .selections
                .iter()
                .map(|selection| CopySelection {
                    source: stage.join(&selection.destination_relative),
                    destination_relative: selection.destination_relative.clone(),
                })
                .collect::<Vec<_>>();
            freshell_platform::provider_environment::copy_environment(
                &selections,
                &host,
                &[],
                Default::default(),
            )
            .unwrap();
            let child_relative = prepared
                .rewritten_resources
                .iter()
                .find(|(_, raw)| raw.contains("name: probe"))
                .unwrap()
                .0
                .clone();
            let child_document = MarkedYamlOwned::load_from_str(
                &std::fs::read_to_string(host.join(&child_relative)).unwrap(),
            )
            .unwrap();
            let namespace_root = child_document[0]
                .data
                .as_mapping_get("bundle")
                .unwrap()
                .data
                .as_mapping_get("namespace_root")
                .and_then(|node| node.data.as_str())
                .unwrap_or(".");
            let reference = child_document[0]
                .data
                .as_mapping_get("context")
                .unwrap()
                .data
                .as_mapping_get("include")
                .unwrap()
                .data
                .as_sequence()
                .unwrap()[0]
                .data
                .as_str()
                .unwrap();
            let (namespace, path) = reference.split_once(':').unwrap();
            assert_eq!(namespace, "probe");
            let source_base = host.join(child_relative.parent().unwrap()).join(if nested {
                namespace_root
            } else {
                "."
            });
            let hidden = owned.path().join("hidden-original-bundle");
            std::fs::rename(&bundle, &hidden).unwrap();
            let output=std::process::Command::new("node").args(["-e","process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.argv[1],process.argv[2])))"]).arg(&source_base).arg(path.trim_start_matches('/')).env_clear().env("PATH",std::env::var_os("PATH").unwrap()).output().unwrap();
            std::fs::rename(&hidden, &bundle).unwrap();
            assert!(output.status.success(),"projected native namespace source base must be readable with original sources hidden: {:?}",output.stderr);
            assert_eq!(output.stdout, b"selected-namespaced-context");
            assert_eq!(std::fs::read_to_string(settings).unwrap(), raw_settings);
            assert_eq!(
                std::fs::read_to_string(bundle.join("bundle.yaml")).unwrap(),
                raw
            );
            assert_eq!(std::fs::read_to_string(child).unwrap(), raw_child);
            if scenario == "self-override" {
                std::fs::remove_file(bundle.join("context/selected.md")).unwrap();
                assert!(prepare(&home, &cwd, &[])
                    .err()
                    .expect("missing standalone context must refuse despite parent decoy")
                    .contains("selected context is missing"));
            }
        }
    }

    #[test]
    fn managed_provider_amplifier_ancestor_names_consume_parent_context_after_both_copies() {
        for (ancestor_name, namespace_root) in [("probe", true), ("probe", false), ("", true)] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let bundle = owned.path().join("external-bundle");
            let cwd = owned.path().join("workspace");
            for directory in [
                &home.join(".amplifier"),
                &cwd,
                &bundle.join("context"),
                &bundle.join("behaviors/context"),
            ] {
                std::fs::create_dir_all(directory).unwrap();
            }
            let parent_raw = format!("bundle: {{name: {ancestor_name:?}}}\n");
            let child_raw = format!(
                "bundle: {{name: probe{}}}\ncontext: {{include: ['probe:context/selected.md']}}\n",
                if namespace_root {
                    ", namespace_root: .."
                } else {
                    ""
                }
            );
            std::fs::write(bundle.join("bundle.yaml"), &parent_raw).unwrap();
            let child = bundle.join("behaviors/probe.yaml");
            std::fs::write(&child, &child_raw).unwrap();
            std::fs::write(
                bundle.join("context/selected.md"),
                "correct-ancestor-context",
            )
            .unwrap();
            std::fs::write(
                bundle.join("behaviors/context/selected.md"),
                "wrong-child-decoy",
            )
            .unwrap();
            let settings_raw = format!(
                "bundle: {{active: {}}}\n",
                serde_json::to_string(&format!("file://{}", child.display())).unwrap()
            );
            let settings = home.join(".amplifier/settings.yaml");
            std::fs::write(&settings, &settings_raw).unwrap();
            let prepared = prepare(&home, &cwd, &[]).unwrap();
            let stage = owned.path().join("stage");
            let host = owned.path().join("host");
            freshell_platform::provider_environment::copy_environment(
                &prepared.selections,
                &stage,
                &[],
                Default::default(),
            )
            .unwrap();
            for (relative, raw) in &prepared.rewritten_resources {
                std::fs::write(stage.join(relative), raw).unwrap();
            }
            let second = prepared
                .selections
                .iter()
                .map(|selection| CopySelection {
                    source: stage.join(&selection.destination_relative),
                    destination_relative: selection.destination_relative.clone(),
                })
                .collect::<Vec<_>>();
            freshell_platform::provider_environment::copy_environment(
                &second,
                &host,
                &[],
                Default::default(),
            )
            .unwrap();
            let projected_child = &prepared
                .rewritten_resources
                .iter()
                .find(|(_, raw)| raw.contains("name: probe"))
                .unwrap()
                .0;
            let projected_resource = host
                .join(projected_child.parent().unwrap())
                .join("context/selected.md");
            let hidden = owned.path().join("hidden-original");
            std::fs::rename(&bundle, &hidden).unwrap();
            let output = std::process::Command::new("node")
                .args([
                    "-e",
                    "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
                ])
                .arg(projected_resource)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
            std::fs::rename(&hidden, &bundle).unwrap();
            assert!(output.status.success());
            assert_eq!(
                output.stdout, b"correct-ancestor-context",
                "ancestor={ancestor_name:?}, override={namespace_root}"
            );
            assert_eq!(std::fs::read_to_string(&settings).unwrap(), settings_raw);
            assert_eq!(std::fs::read_to_string(&child).unwrap(), child_raw);
            assert_eq!(
                std::fs::read_to_string(bundle.join("bundle.yaml")).unwrap(),
                parent_raw
            );
            std::fs::remove_file(bundle.join("context/selected.md")).unwrap();
            assert!(prepare(&home, &cwd, &[])
                .err()
                .expect("missing ancestor target must refuse despite child decoy")
                .contains("selected context is missing"));
        }
    }

    #[test]
    fn managed_provider_amplifier_namespace_context_missing_selected_resource_is_refused() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir_all(home.join(".amplifier")).unwrap();
        let bundle = owned.path().join("bundle.yaml");
        std::fs::write(
            &bundle,
            "bundle: {name: probe}\ncontext: {include: ['probe:context/missing.md']}\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".amplifier/settings.yaml"),
            format!(
                "bundle: {{active: {}}}\n",
                serde_json::to_string(&bundle).unwrap()
            ),
        )
        .unwrap();
        let error = prepare(&home, owned.path(), &[])
            .err()
            .expect("missing selected namespace context blocks preparation");
        assert!(error.contains("selected context is missing"), "{error}");
        assert!(!owned.path().join("stage").exists());
    }

    #[test]
    fn managed_provider_amplifier_top_local_forms_consume_modules_context_and_dependencies_after_both_copies(
    ) {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let bundle = owned.path().join("external-bundle");
        let module = bundle.join("modules/probe");
        for path in [
            &home.join(".amplifier"),
            &cwd,
            &module.join("node_modules/dependency"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        let raw_bundle = "bundle: {name: selected}\ncontext:\n  include: [context.md]\nsession:\n  orchestrator:\n    module: probe\n    source: ./modules/probe\n";
        std::fs::write(bundle.join("bundle.yaml"), raw_bundle).unwrap();
        std::fs::write(bundle.join("context.md"), "selected-context").unwrap();
        std::fs::write(module.join("resource"), "module-resource").unwrap();
        std::fs::write(
            module.join("node_modules/dependency/index.js"),
            "module.exports='installed-dependency';",
        )
        .unwrap();
        std::fs::write(module.join("consume.cjs"), "const fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('dependency')+':'+fs.readFileSync(process.argv[2],'utf8'));").unwrap();
        for (ordinal, source) in [
            bundle.join("bundle.yaml").display().to_string(),
            "../external-bundle/bundle.yaml".into(),
            "./../external-bundle/bundle.yaml".into(),
        ]
        .iter()
        .enumerate()
        {
            let raw_settings = format!(
                "bundle:\n  active: {}\n",
                serde_json::to_string(source).unwrap()
            );
            let settings = home.join(".amplifier/settings.yaml");
            std::fs::write(&settings, &raw_settings).unwrap();
            let prepared = prepare(&home, &cwd, &[]).unwrap();
            let staged_settings = prepared
                .rewritten_settings
                .as_ref()
                .expect("selected top-level local bundle is projected");
            let projected_source = MarkedYamlOwned::load_from_str(staged_settings).unwrap()[0]
                .data
                .as_mapping_get("bundle")
                .unwrap()
                .data
                .as_mapping_get("active")
                .unwrap()
                .data
                .as_str()
                .unwrap()
                .to_owned();
            let stage = owned.path().join(format!("stage-{ordinal}"));
            let host = owned.path().join(format!("host-{ordinal}"));
            freshell_platform::provider_environment::copy_environment(
                &prepared.selections,
                &stage,
                &[],
                Default::default(),
            )
            .unwrap();
            for (relative, raw) in &prepared.rewritten_resources {
                std::fs::write(stage.join(relative), raw).unwrap();
            }
            let selections = prepared
                .selections
                .iter()
                .map(|selection| CopySelection {
                    source: stage.join(&selection.destination_relative),
                    destination_relative: selection.destination_relative.clone(),
                })
                .collect::<Vec<_>>();
            freshell_platform::provider_environment::copy_environment(
                &selections,
                &host,
                &[],
                Default::default(),
            )
            .unwrap();
            let relative = Path::new(projected_source.strip_prefix("file://").unwrap())
                .strip_prefix("/home/freshell/provider")
                .unwrap();
            let projected_bundle = host.join(relative);
            let projected_raw = std::fs::read_to_string(&projected_bundle).unwrap();
            let document = MarkedYamlOwned::load_from_str(&projected_raw).unwrap();
            let module_source = document[0]
                .data
                .as_mapping_get("session")
                .unwrap()
                .data
                .as_mapping_get("orchestrator")
                .unwrap()
                .data
                .as_mapping_get("source")
                .unwrap()
                .data
                .as_str()
                .unwrap();
            let module = host.join(
                Path::new(module_source.strip_prefix("file://").unwrap())
                    .strip_prefix("/home/freshell/provider")
                    .unwrap(),
            );
            let context = document[0]
                .data
                .as_mapping_get("context")
                .unwrap()
                .data
                .as_mapping_get("include")
                .unwrap()
                .data
                .as_sequence()
                .unwrap()[0]
                .data
                .as_str()
                .unwrap();
            let hidden = owned.path().join("hidden-original-bundle");
            std::fs::rename(&bundle, &hidden).unwrap();
            let output = std::process::Command::new("node")
                .arg(module.join("consume.cjs"))
                .arg(projected_bundle.parent().unwrap().join(context))
                .current_dir(&cwd)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
            std::fs::rename(&hidden, &bundle).unwrap();
            assert!(
                output.status.success(),
                "selected top bundle modules and context must work with originals unavailable"
            );
            assert_eq!(
                output.stdout,
                b"module-resource:installed-dependency:selected-context"
            );
            assert_eq!(std::fs::read_to_string(settings).unwrap(), raw_settings);
            assert_eq!(
                std::fs::read_to_string(bundle.join("bundle.yaml")).unwrap(),
                raw_bundle
            );
        }
    }

    #[test]
    fn managed_provider_amplifier_top_local_forms_block_missing_and_unreadable_sources_and_preserve_native_names(
    ) {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        std::fs::create_dir_all(home.join(".amplifier")).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let settings = home.join(".amplifier/settings.yaml");
        let selected = owned.path().join("bundle.yaml");
        for source in [
            selected.display().to_string(),
            "../bundle.yaml".into(),
            "./../bundle.yaml".into(),
        ] {
            for unreadable in [false, true] {
                if unreadable {
                    std::fs::write(&selected, "bundle: {name: selected}\n").unwrap();
                    std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0))
                        .unwrap();
                }
                let raw = format!(
                    "bundle:\n  active: {}\n",
                    serde_json::to_string(&source).unwrap()
                );
                std::fs::write(&settings, &raw).unwrap();
                let result = prepare(&home, &cwd, &[]);
                if unreadable {
                    std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    std::fs::remove_file(&selected).unwrap();
                }
                let error = result
                    .err()
                    .expect("unavailable selected top-level local bundle must block preparation");
                assert!(error.contains(if unreadable { "unreadable" } else { "missing" }));
                assert_eq!(std::fs::read_to_string(&settings).unwrap(), raw);
            }
        }
        for name in [
            "registered-bundle",
            "git+https://example.invalid/bundle",
            "https://example.invalid/bundle",
        ] {
            let raw = format!("bundle:\n  active: {name}\n");
            std::fs::write(&settings, &raw).unwrap();
            let prepared = prepare(&home, &cwd, &[]).unwrap();
            assert!(prepared.selections.is_empty());
            assert!(prepared.rewritten_settings.is_none());
            assert_eq!(std::fs::read_to_string(&settings).unwrap(), raw);
        }
    }

    #[test]
    fn amplifier_local_module_source_executes_after_projection_from_unrelated_cwd() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let bundle = owned.path().join("bundle");
        let module = bundle.join("modules/loop-probe");
        let cwd = owned.path().join("unrelated-workspace");
        let stage = owned.path().join("stage");
        for path in [
            &home.join(".amplifier"),
            &module.join("node_modules/dep"),
            &cwd,
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            home.join(".amplifier/settings.yaml"),
            format!("bundle:\n  active: file://{}\n", bundle.display()),
        )
        .unwrap();
        std::fs::write(bundle.join("bundle.yaml"), "bundle:\n  name: selected\nsession:\n  orchestrator:\n    module: loop-probe\n    source: ./modules/loop-probe\n").unwrap();
        std::fs::write(module.join("resource"), "module-resource").unwrap();
        std::fs::write(
            module.join("node_modules/dep/index.js"),
            "module.exports='installed-dependency'",
        )
        .unwrap();
        std::fs::write(module.join("consume.cjs"), "const fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('dep'));").unwrap();
        let prepared = prepare(&home, &cwd, &[]).unwrap();
        freshell_platform::provider_environment::copy_environment(
            &prepared.selections,
            &stage,
            &[],
            Default::default(),
        )
        .unwrap();
        for (path, bytes) in prepared.rewritten_resources {
            std::fs::write(stage.join(path), bytes).unwrap();
        }
        let document = std::fs::read_to_string(
            stage.join(".freshell/resources/amplifier-local-0/bundle.yaml"),
        )
        .unwrap();
        let parsed = MarkedYamlOwned::load_from_str(&document).unwrap();
        let source = parsed[0]
            .data
            .as_mapping_get("session")
            .unwrap()
            .data
            .as_mapping_get("orchestrator")
            .unwrap()
            .data
            .as_mapping_get("source")
            .unwrap()
            .data
            .as_str()
            .unwrap();
        let selected = if let Some(path) = source.strip_prefix("file://") {
            stage.join(
                Path::new(path)
                    .strip_prefix("/home/freshell/provider")
                    .unwrap(),
            )
        } else {
            cwd.join(source)
        };
        let output = std::process::Command::new("node")
            .arg(selected.join("consume.cjs"))
            .current_dir(&cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "selected local module must execute independently of launch cwd"
        );
        assert_eq!(output.stdout, b"module-resource:installed-dependency");
    }
}

fn native_mapping_value<'a>(
    node: &'a MarkedYamlOwned,
    key: &str,
    depth: usize,
) -> Result<Option<&'a MarkedYamlOwned>, String> {
    if depth > 64 {
        return Err("Amplifier YAML merge depth exceeded".into());
    }
    if let Some(value) = node.data.as_mapping_get(key) {
        return Ok(Some(value));
    }
    let Some(merged) = node.data.as_mapping_get("<<") else {
        return Ok(None);
    };
    if merged.data.as_mapping().is_some() {
        return native_mapping_value(merged, key, depth + 1);
    }
    if let Some(sequence) = merged.data.as_sequence() {
        for map in sequence {
            if map.data.as_mapping().is_none() {
                return Err("Amplifier YAML merge requires mappings".into());
            }
            if let Some(value) = native_mapping_value(map, key, depth + 1)? {
                return Ok(Some(value));
            }
        }
        return Ok(None);
    }
    Err("Amplifier YAML merge requires a mapping or sequence".into())
}

fn rewrite_bundle_active(
    raw: &str,
    document: &MarkedYamlOwned,
    bundle: &MarkedYamlOwned,
    active: &MarkedYamlOwned,
    replacement: &str,
) -> Result<String, String> {
    if document.data.as_mapping_get("bundle").is_none() {
        return Err(
            "Amplifier inherited bundle source requires an independent YAML occurrence projection"
                .into(),
        );
    }
    let bundle_start = source_offset(raw, bundle.span.start)?;
    let bundle_end = source_offset(raw, bundle.span.end)?;
    let start = source_offset(raw, active.span.start)?;
    let end = source_offset(raw, active.span.end)?;
    let token = raw
        .get(bundle_start..bundle_end)
        .ok_or("Amplifier bundle source span is invalid")?;
    let (start, end, replacement) = if token.starts_with('*') {
        (
            bundle_start,
            bundle_end,
            format!("{{<<: {token}, active: {replacement}}}"),
        )
    } else if bundle.data.as_mapping_get("active").is_some()
        && start >= bundle_start
        && end <= bundle_end
    {
        (start, end, replacement.to_owned())
    } else if token.starts_with('{') && token.ends_with('}') {
        (
            bundle_end - 1,
            bundle_end - 1,
            format!(", active: {replacement}"),
        )
    } else {
        let newline = if bundle_end > 0 && raw.as_bytes()[bundle_end - 1] != b'\n' {
            "\n"
        } else {
            ""
        };
        (
            bundle_end,
            bundle_end,
            format!(
                "{newline}{}active: {replacement}\n",
                " ".repeat(bundle.span.start.col())
            ),
        )
    };
    if start > end {
        return Err("Amplifier selected source span is invalid".into());
    }
    let size = raw
        .len()
        .checked_sub(end - start)
        .and_then(|size| size.checked_add(replacement.len()))
        .ok_or("Amplifier source template size overflow")?;
    if size > 16 * 1024 * 1024 {
        return Err("Amplifier source template exceeds 16 MiB".into());
    }
    let mut template = String::with_capacity(size);
    template.push_str(&raw[..start]);
    template.push_str(&replacement);
    template.push_str(&raw[end..]);
    Ok(template)
}

fn source_offset(raw: &str, marker: saphyr::Marker) -> Result<usize, String> {
    let mut start = 0usize;
    for _ in 1..marker.line() {
        start = start
            .checked_add(
                raw[start..]
                    .find('\n')
                    .ok_or("Amplifier source span line is unavailable")?
                    + 1,
            )
            .ok_or("Amplifier source span offset overflow")?;
    }
    let line = &raw[start..];
    let offset = line
        .char_indices()
        .nth(marker.col())
        .map(|(index, _)| index)
        .or_else(|| (line.chars().count() == marker.col()).then_some(line.len()))
        .ok_or("Amplifier source span column is unavailable")?;
    start
        .checked_add(offset)
        .ok_or_else(|| "Amplifier source span offset overflow".into())
}

/// The loader clones anchored subtrees. Charge those clones before loading,
/// without retaining source scalar values in an auxiliary tree.
fn bound_yaml_expansion(raw: &str) -> Result<(), String> {
    use saphyr_parser::{Event, Parser};
    let mut anchors = BTreeMap::<usize, usize>::new();
    let mut stack = Vec::<(usize, usize)>::new();
    let mut document_bytes = 0usize;
    let mut anchor_bytes = 0usize;
    let mut documents = 0usize;
    let limit = 64 * 1024 * 1024usize;
    for event in Parser::new_from_iter(raw.chars()) {
        let (event, _) = event.map_err(|_| "Amplifier selected settings YAML is invalid")?;
        let (weight, anchor, collection) = match event {
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err("Amplifier selected settings must contain one YAML document".into());
                }
                continue;
            }
            Event::Scalar(value, _, anchor, _) => (
                128usize
                    .checked_add(value.len())
                    .ok_or("Amplifier YAML node size overflow")?,
                anchor,
                false,
            ),
            Event::SequenceStart(anchor, _) | Event::MappingStart(anchor, _) => (128, anchor, true),
            Event::Alias(id) => (
                *anchors
                    .get(&id)
                    .ok_or("Amplifier YAML alias is cyclic or unavailable")?,
                0,
                false,
            ),
            Event::SequenceEnd | Event::MappingEnd => {
                let (anchor, weight) = stack.pop().ok_or("Amplifier YAML structure is invalid")?;
                if anchor != 0 {
                    anchor_bytes = anchor_bytes
                        .checked_add(weight)
                        .ok_or("Amplifier YAML anchor size overflow")?;
                    anchors.insert(anchor, weight);
                }
                if let Some((_, parent)) = stack.last_mut() {
                    *parent = parent
                        .checked_add(weight)
                        .ok_or("Amplifier YAML node size overflow")?;
                }
                if raw
                    .len()
                    .checked_add(document_bytes)
                    .and_then(|bytes| bytes.checked_add(anchor_bytes))
                    .is_none_or(|bytes| bytes > limit)
                {
                    return Err("Amplifier YAML source-view expansion exceeds 64 MiB".into());
                }
                continue;
            }
            _ => continue,
        };
        document_bytes = document_bytes
            .checked_add(weight)
            .ok_or("Amplifier YAML source-view size overflow")?;
        if collection {
            stack.push((anchor, weight));
        } else {
            if anchor != 0 {
                anchor_bytes = anchor_bytes
                    .checked_add(weight)
                    .ok_or("Amplifier YAML anchor size overflow")?;
                anchors.insert(anchor, weight);
            }
            if let Some((_, parent)) = stack.last_mut() {
                *parent = parent
                    .checked_add(weight)
                    .ok_or("Amplifier YAML node size overflow")?;
            }
        }
        if raw
            .len()
            .checked_add(document_bytes)
            .and_then(|bytes| bytes.checked_add(anchor_bytes))
            .is_none_or(|bytes| bytes > limit)
        {
            return Err("Amplifier YAML source-view expansion exceeds 64 MiB".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_provider_amplifier_local_graph_rejects_cycles_and_reuses_completed_diamonds() {
        let fixture = tempfile::tempdir().unwrap();
        let settings = fixture.path().join(".amplifier/settings.yaml");
        std::fs::create_dir(settings.parent().unwrap()).unwrap();
        let a = fixture.path().join("a.yaml");
        let b = fixture.path().join("b.yaml");
        let c = fixture.path().join("c.yaml");
        let d = fixture.path().join("d.yaml");
        std::fs::write(
            &settings,
            format!("bundle:\n  active: 'file://{}'\n", a.display()),
        )
        .unwrap();
        std::fs::write(&a, format!("includes: ['file://{}']\n", b.display())).unwrap();
        std::fs::write(&b, format!("includes: ['file://{}']\n", a.display())).unwrap();
        assert_eq!(
            prepare(fixture.path(), fixture.path(), &[]).err().unwrap(),
            "Amplifier local include cycle detected"
        );
        std::fs::write(
            &a,
            format!(
                "includes: ['file://{}','file://{}']\n",
                b.display(),
                c.display()
            ),
        )
        .unwrap();
        std::fs::write(&b, format!("includes: ['file://{}']\n", d.display())).unwrap();
        std::fs::write(&c, format!("includes: ['file://{}']\n", d.display())).unwrap();
        std::fs::write(&d, "bundle: {name: shared}\n").unwrap();
        let prepared = prepare(fixture.path(), fixture.path(), &[]).unwrap();
        assert_eq!(prepared.selections.iter().filter(|selection|selection.source==d).count(),1,
            "a completed local include shared by two branches retains one approved input generation");
        std::fs::remove_file(d).unwrap();
        assert!(
            prepare(fixture.path(), fixture.path(), &[]).is_err(),
            "missing declared include must not be silently skipped"
        );
    }
    #[test]
    fn managed_provider_amplifier_resource_errors_preserve_private_input() {
        let fixture = tempfile::tempdir().unwrap();
        let settings = fixture.path().join(".amplifier/settings.yaml");
        std::fs::create_dir(settings.parent().unwrap()).unwrap();
        let raw = "private: PRIVATE_YAML_SENTINEL\nbundle: [invalid\n";
        std::fs::write(&settings, raw).unwrap();
        let error = prepare(fixture.path(), fixture.path(), &[]).err().unwrap();
        assert!(!error.contains("PRIVATE_YAML_SENTINEL"));
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), raw);
    }
    #[test]
    fn managed_provider_amplifier_alias_expansion_is_bounded_before_loader_clone() {
        let fixture = tempfile::tempdir().unwrap();
        let settings = fixture.path().join(".amplifier/settings.yaml");
        std::fs::create_dir(settings.parent().unwrap()).unwrap();
        let mut raw = String::from("v0: &a0 [synthetic, synthetic]\n");
        for depth in 1..20 {
            raw.push_str(&format!(
                "v{depth}: &a{depth} [*a{}, *a{}]\n",
                depth - 1,
                depth - 1
            ));
        }
        std::fs::write(&settings, raw).unwrap();
        assert_eq!(
            prepare(fixture.path(), fixture.path(), &[]).err().unwrap(),
            "Amplifier YAML source-view expansion exceeds 64 MiB"
        );
        assert!(bound_yaml_expansion("root: &loop [*loop]\n").is_err());
    }
    #[test]
    fn managed_provider_amplifier_resource_selection_rejects_credential_alias_before_copy() {
        let fixture = tempfile::tempdir().unwrap();
        let settings = fixture.path().join(".amplifier/settings.yaml");
        std::fs::create_dir(settings.parent().unwrap()).unwrap();
        let credential = fixture.path().join("credential.yaml");
        std::fs::write(&credential, "PRIVATE_CREDENTIAL_SENTINEL").unwrap();
        std::fs::write(
            &settings,
            format!("bundle:\n  active: 'file://{}'\n", credential.display()),
        )
        .unwrap();
        let error = prepare(
            fixture.path(),
            fixture.path(),
            std::slice::from_ref(&credential),
        )
        .err()
        .unwrap();
        assert!(error.contains("aliases credentials"));
        assert!(!error.contains("PRIVATE_CREDENTIAL_SENTINEL"));
        assert_eq!(
            std::fs::read_to_string(credential).unwrap(),
            "PRIVATE_CREDENTIAL_SENTINEL"
        );
    }
}
