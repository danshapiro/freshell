//! Stage source views in the grant's private filesystem before publication.
use super::{private_directory, write_private_bytes};
use crate::managed_provider_references::sources::{PlannedSourceOccurrence, SourceLane};
use freshell_platform::opencode_recipe::{SelectedSourceFile, SourceManifest, SourceView};
use std::{collections::BTreeMap, path::Path};

/// Selected discovery roots are complete writable units, independent of the
/// private rewritten configuration leaves mounted inside them.
pub(super) fn resource_units(
    home: &Path,
    global: &Path,
    plan: &[PlannedSourceOccurrence],
) -> Result<
    Vec<(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )>,
    String,
> {
    use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};
    let mut roots = BTreeMap::new();
    for source in plan {
        if source.source.lane == SourceLane::Inline {
            continue;
        }
        let Some(parent) = source.source.logical_path.parent() else {
            continue;
        };
        if parent == global || parent.file_name() != Some(std::ffi::OsStr::new(".opencode")) {
            continue;
        }
        let canonical = std::fs::canonicalize(parent)
            .map_err(|_| "selected OpenCode resource root is unavailable, dangling or cyclic")?;
        if !canonical.is_dir() {
            return Err("selected OpenCode resource root must be a directory".into());
        }
        roots.insert(parent.to_path_buf(), canonical);
    }
    let mut units = Vec::new();
    for (ordinal, (logical, canonical)) in roots.into_iter().enumerate() {
        let destination = crate::managed_provider_references::sources::runtime_config_destination(
            home, global, &logical,
        );
        let effective = crate::managed_provider_references::sources::runtime_config_destination(
            home, global, &canonical,
        );
        units.push((
            canonical,
            ProviderResourceMount {
                stage_relative_path: format!(".freshell/resource-units/root-{ordinal}"),
                provider_relative_path: format!(".freshell/provider-roots/root-{ordinal}"),
                logical_destination: destination
                    .to_str()
                    .ok_or("resource destination is not UTF-8")?
                    .into(),
                effective_destination: effective
                    .to_str()
                    .ok_or("resource destination is not UTF-8")?
                    .into(),
                kind: ProviderResourceKind::Directory,
            },
        ));
    }
    Ok(units)
}

pub(super) fn read_source_view(root: &Path, relative: &str) -> Result<String, String> {
    use std::io::Read;
    if Path::new(relative)
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("accepted source view has an invalid private path".into());
    }
    let path = root.join(relative);
    if !std::fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        || std::fs::canonicalize(&path).map_err(|_| "accepted source view is unavailable")? != path
    {
        return Err("accepted source view must be a physical stage file".into());
    }
    let mut raw = String::new();
    std::fs::File::open(path)
        .map_err(|_| "accepted source view is unavailable")?
        .take(16 * 1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "accepted source view read failed")?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err("accepted source view exceeds 16 MiB".into());
    }
    Ok(raw)
}

pub(super) fn stage(
    root: &Path,
    home: &Path,
    cwd: &Path,
    plan: &[PlannedSourceOccurrence],
    input: super::OpencodeEphemeralInput<'_>,
) -> Result<(), String> {
    let mut manifest = SourceManifest {
        version: 1,
        cwd: cwd.into(),
        original_home: home.into(),
        sources: Vec::new(),
        files: Vec::new(),
        frozen_inputs: input.frozen_inputs.unwrap_or(&[]).to_vec(),
        user_owns_freshell_mcp: false,
        native_source_flags: input.native_source_flags.unwrap_or(&[]).to_vec(),
        rebind_enabled: input.rebind_enabled.unwrap_or(true),
        inline_edits: input.inline_edits.cloned().unwrap_or_default(),
    };
    private_directory(&root.join(".freshell/source-views"))?;
    private_directory(&root.join(".freshell/templates"))?;
    let mut files = BTreeMap::new();
    let mut view_bytes = 0usize;
    for (ordinal, source) in plan.iter().enumerate() {
        if source.source.lane == SourceLane::Main {
            manifest.user_owns_freshell_mcp |=
                freshell_platform::opencode_config::source_owns_freshell_mcp(
                    source.references.unexpanded_source(),
                    &source.source.logical_path,
                    cwd,
                )
                .map_err(|error| error.to_string())?;
        }
        view_bytes = view_bytes
            .checked_add(source.references.unexpanded_source().len())
            .and_then(|value| value.checked_add(source.references.template.len()))
            .ok_or("source view size overflow")?;
        if source.references.unexpanded_source().len() > 16 * 1024 * 1024
            || source.references.template.len() > 16 * 1024 * 1024
            || view_bytes > 64 * 1024 * 1024
            || ordinal >= 8192
        {
            return Err("source view profile exceeded before stage publication".into());
        }
        let raw = format!(".freshell/source-views/source-{ordinal}");
        let template = format!(".freshell/templates/source-{ordinal}");
        write_private_bytes(
            &root.join(&raw),
            source.references.unexpanded_source().as_bytes(),
        )?;
        write_private_bytes(&root.join(&template), source.references.template.as_bytes())?;
        for selection in &source.references.selections {
            let index = selection
                .runtime_destination
                .strip_prefix("/home/freshell/provider/.freshell/references/")
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|value| *value < 128)
                .ok_or("source plan contains an invalid indexed destination")?;
            if files
                .insert(index, selection.canonical_source.clone())
                .is_some_and(|prior| prior != selection.canonical_source)
            {
                return Err("source plan changes one indexed source identity".into());
            }
        }
        manifest.sources.push(SourceView {
            logical_path: source.source.logical_path.clone(),
            native_destination: Some(
                crate::managed_provider_references::sources::runtime_config_destination(
                    home,
                    input.config_root.unwrap_or(&home.join(".config/opencode")),
                    &source.source.logical_path,
                )
                .to_str()
                .ok_or("native source destination is not UTF-8")?
                .into(),
            ),
            lane: match source.source.lane {
                SourceLane::Main => freshell_platform::opencode_recipe::SourceLane::Main,
                SourceLane::Tui => freshell_platform::opencode_recipe::SourceLane::Tui,
                SourceLane::Inline => freshell_platform::opencode_recipe::SourceLane::Inline,
            },
            unexpanded_relative_path: raw,
            template_relative_path: template,
            template_sha256: Some({
                use sha2::Digest;
                format!(
                    "{:x}",
                    sha2::Sha256::digest(source.references.template.as_bytes())
                )
            }),
            generated_name: source
                .references
                .recipes
                .first()
                .map(|recipe| recipe.generated_name.clone()),
            occurrences: source.references.occurrences.clone(),
            referenced_variables: source.references.referenced_variables.clone(),
            path_variables: source.references.path_variables.clone(),
            original_form: source.original_form,
        });
    }
    for (expected, (source_id, canonical_source)) in files.into_iter().enumerate() {
        if source_id as usize != expected {
            return Err("source indexes are not contiguous".into());
        }
        manifest.files.push(SelectedSourceFile {
            source_id,
            canonical_source,
        });
    }
    let metadata = freshell_runtime_protocol::bounded_json_bytes(&manifest, 64 * 1024 * 1024)
        .map_err(|_| "source manifest metadata profile exceeded")?;
    write_private_bytes(&root.join(".freshell/input-manifest.json"), &metadata)
}

pub(super) fn describe(
    root: &Path,
    home: &Path,
    plan: &[PlannedSourceOccurrence],
    soul: &freshell_runtime_protocol::SoulId,
    capability: &freshell_runtime_protocol::McpCapabilityReference,
    initial_auth_reservation: Option<&str>,
    config_root: Option<&Path>,
) -> Result<freshell_runtime_protocol::PreparedProviderInputs, String> {
    use freshell_runtime_protocol::*;
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let runtime_home = Path::new("/home/freshell/provider");
    let default_global = home.join(".config/opencode");
    let global = config_root.unwrap_or(&default_global);
    let mut sources = BTreeMap::new();
    let mut binds = Vec::new();
    let mut recipes = 0usize;
    let mut aliases = Vec::new();
    let mut alias_sources = BTreeMap::new();
    for (ordinal, occurrence) in plan.iter().enumerate() {
        if occurrence.source.lane != SourceLane::Inline && !occurrence.original_form {
            let logical = &occurrence.source.logical_path;
            let destination = freshell_platform::opencode_config::lexical_path(
                &crate::managed_provider_references::sources::runtime_config_destination(
                    home, global, logical,
                ),
            );
            let effective = if let Ok(relative) = logical.strip_prefix(&global) {
                let physical = std::fs::canonicalize(root.join(relative))
                    .map_err(|_| "selected global config is unavailable in its private stage")?;
                let relative = physical
                    .strip_prefix(root)
                    .map_err(|_| "selected global config escaped its owned stage")?;
                if relative.starts_with(".freshell/resources") {
                    runtime_home.join(relative)
                } else {
                    runtime_home.join(".config/opencode").join(relative)
                }
            } else {
                occurrence
                    .source
                    .canonical_source
                    .strip_prefix(home)
                    .map(|relative| runtime_home.join(relative))
                    .unwrap_or_else(|_| occurrence.source.canonical_source.clone())
            };
            binds.push(ProviderConfigBind {
                source_relative_path: format!(".freshell/templates/source-{ordinal}"),
                logical_destination: destination
                    .to_str()
                    .ok_or("config destination is not UTF-8")?
                    .into(),
                effective_destination: effective
                    .to_str()
                    .ok_or("config destination is not UTF-8")?
                    .into(),
            });
        }
        recipes = recipes
            .checked_add(occurrence.references.recipes.len())
            .ok_or("source recipe count overflow")?;
        for selected in &occurrence.references.selections {
            let id = selected
                .runtime_destination
                .strip_prefix("/home/freshell/provider/.freshell/references/")
                .and_then(|id| id.parse::<u16>().ok())
                .filter(|id| *id < 128)
                .ok_or("invalid selected source index")?;
            if sources
                .insert(id, &selected.canonical_source)
                .is_some_and(|prior| prior != &selected.canonical_source)
            {
                return Err("selected source identity changed under one index".into());
            }
        }
        if occurrence.original_form {
            for approved in &occurrence.references.occurrences {
                let source_id = approved
                    .runtime_destination
                    .strip_prefix("/home/freshell/provider/.freshell/references/")
                    .and_then(|value| value.parse::<u16>().ok())
                    .ok_or("original-form alias has no approved source index")?;
                let selected = sources
                    .get(&source_id)
                    .ok_or("original-form alias index is unavailable")?;
                let logical =
                    crate::managed_provider_references::sources::runtime_config_destination(
                        home,
                        global,
                        &approved.approved_alias,
                    );
                let effective =
                    crate::managed_provider_references::sources::runtime_config_destination(
                        home, global, selected,
                    );
                if let Some(prior) = alias_sources.insert(logical.clone(), source_id) {
                    if prior != source_id {
                        return Err("shared source has conflicting private alias selections; reprepare before dispatch".into());
                    }
                    continue;
                }
                if aliases.len() >= 256 {
                    return Err("configuration alias count exceeds 256".into());
                }
                aliases.push(IndexedProviderFileAlias {
                    source_id,
                    logical_destination: logical
                        .to_str()
                        .ok_or("alias destination is not UTF-8")?
                        .into(),
                    effective_destination: effective
                        .to_str()
                        .ok_or("alias destination is not UTF-8")?
                        .into(),
                });
            }
        }
    }
    let mut file = std::fs::File::open(root.join(".freshell/input-manifest.json"))
        .map_err(|_| "prepared source manifest unavailable")?
        .take(64 * 1024 * 1024 + 1);
    let mut hash = Sha256::new();
    let mut used = 0usize;
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|_| "prepared source manifest read failed")?;
        if size == 0 {
            break;
        }
        used = used
            .checked_add(size)
            .ok_or("source manifest size overflow")?;
        if used > 64 * 1024 * 1024 {
            return Err("source manifest metadata exceeds 64 MiB".into());
        }
        hash.update(&buffer[..size]);
    }
    let inputs = PreparedProviderInputs {
        generation_id: capability.grant_id.clone(),
        initial_auth_reservation: initial_auth_reservation.map(str::to_string),
        manifest: ProviderInputManifestReference {
            relative_path: ".freshell/input-manifest.json".into(),
            sha256: format!("{:x}", hash.finalize()),
            source_count: u16::try_from(sources.len())
                .map_err(|_| "selected source count overflow")?,
            alias_count: u16::try_from(aliases.len()).map_err(|_| "source alias count overflow")?,
            recipe_count: u16::try_from(recipes).map_err(|_| "recipe count overflow")?,
        },
        config_binds: binds,
        resource_mounts: {
            let mut bytes = Vec::new();
            std::fs::File::open(root.join(".freshell/resource-mounts.json"))
                .map_err(|_| "prepared resource manifest unavailable")?
                .take(MAX_CONTROL_FRAME_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "prepared resource manifest read failed")?;
            if bytes.len() > MAX_CONTROL_FRAME_BYTES {
                return Err("prepared resource descriptor exceeds control profile".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "prepared resource descriptors invalid")?
        },
        indexed_files: (!sources.is_empty()).then(|| IndexedProviderFiles {
            volume_name: indexed_provider_volume_name(soul, &capability.grant_id),
            aliases,
        }),
    };
    inputs
        .validate(Some(capability))
        .map_err(|error| error.message)?;
    let metadata = bounded_json_bytes(&inputs, MAX_CONTROL_FRAME_BYTES)
        .map_err(|_| "prepared descriptor exceeds control profile")?;
    write_private_bytes(&root.join(".freshell/prepared-inputs.json"), &metadata)?;
    super::allow_controller_stage_read(&root.join(".freshell/prepared-inputs.json"))?;
    Ok(inputs)
}
