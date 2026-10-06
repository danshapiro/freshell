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
    let Some(local) = source.strip_prefix("file://") else {
        return Ok(result);
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
    let relative = Path::new(".freshell/resources/amplifier-local-0");
    let runtime = Path::new("/home/freshell/provider")
        .join(relative)
        .join(leaf);
    let runtime = runtime
        .to_str()
        .ok_or("Amplifier projected bundle path is not UTF-8")?;
    let replacement = serde_json::to_string(&format!("file://{runtime}"))
        .map_err(|_| "Amplifier projected source could not be encoded")?;
    let template = rewrite_bundle_active(&raw, document, bundle, active, &replacement)?;
    if metadata.is_dir() {
        result.selections.push(CopySelection {
            source: root,
            destination_relative: relative.into(),
        });
    } else {
        // A standalone bundle document does not select its entire parent
        // directory. Preserve only its finite resources and native package
        // closure; selecting a document in HOME must not copy HOME wholesale.
        if !canonical
            .extension()
            .is_some_and(|extension| extension == "yaml" || extension == "yml" || extension == "md")
        {
            return Err("Amplifier local bundle source has an unsupported native format".into());
        }
        result.selections.push(CopySelection {
            source: canonical.clone(),
            destination_relative: relative.join(
                canonical
                    .file_name()
                    .ok_or("Amplifier bundle filename unavailable")?,
            ),
        });
        let mut bundle_raw = String::new();
        std::fs::File::open(&canonical)
            .map_err(|_| "Amplifier selected bundle unreadable")?
            .take(16 * 1024 * 1024 + 1)
            .read_to_string(&mut bundle_raw)
            .map_err(|_| "Amplifier selected bundle is unreadable or not UTF-8")?;
        if bundle_raw.len() > 16 * 1024 * 1024 {
            return Err("Amplifier selected bundle source exceeds 16 MiB".into());
        }
        if canonical
            .extension()
            .is_some_and(|extension| extension == "yaml" || extension == "yml")
        {
            bound_yaml_expansion(&bundle_raw)?;
            let bundle_documents = MarkedYamlOwned::load_from_str(&bundle_raw)
                .map_err(|_| "Amplifier selected bundle YAML is invalid")?;
            if bundle_documents.len() != 1 {
                return Err("Amplifier selected bundle requires one YAML document".into());
            }
            let mut bundle_replacements = Vec::new();
            if let Some(context) = bundle_documents[0]
                .data
                .as_mapping_get("context")
                .and_then(|node| node.data.as_mapping())
            {
                for (name, node) in context {
                    if name.data.as_str() == Some("include") {
                        continue;
                    }
                    let Some(value) = node.data.as_str() else {
                        continue;
                    };
                    let path = Path::new(value);
                    let selected = if path.is_absolute() {
                        path.to_owned()
                    } else {
                        root.join(path)
                    };
                    let independent = path.is_absolute()
                        || path
                            .components()
                            .any(|component| matches!(component, std::path::Component::ParentDir));
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
                        let start = source_offset(&bundle_raw, node.span.start)?;
                        let end = source_offset(&bundle_raw, node.span.end)?;
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
                result.rewritten_resources.push((
                    relative.join(
                        canonical
                            .file_name()
                            .ok_or("Amplifier bundle filename unavailable")?,
                    ),
                    template,
                ));
            }
        }
    }
    result.rewritten_settings = Some(template);
    Ok(result)
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
