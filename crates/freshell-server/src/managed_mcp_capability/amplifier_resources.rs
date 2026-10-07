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
    if !source.starts_with("file://") {
        return Ok(result);
    }
    let mut state = BundleSelection {
        view_bytes: raw.len(),
        ..Default::default()
    };
    if let Some(runtime) = select_local_bundle(source, cwd, excluded, &mut result, &mut state)? {
        let replacement = serde_json::to_string(&runtime)
            .map_err(|_| "Amplifier projected source could not be encoded")?;
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
    state.metadata_bytes = state
        .metadata_bytes
        .checked_add(canonical.as_os_str().len())
        .ok_or("Amplifier selected source metadata overflow")?;
    if state.metadata_bytes > 8 * 1024 * 1024 {
        return Err("Amplifier selected source metadata budget exceeded".into());
    }
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
                        if include && value.contains(':') {
                            return Err("Amplifier namespace context requires its retained source-base projection".into());
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
