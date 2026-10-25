//! Native-selected ordinary inputs use the shared resource copier and
//! existing exact mounts. No configuration payload enters callback metadata.
use super::{private_directory, write_private_bytes};
use crate::managed_provider_references::codex::{discover, InputKind};
use freshell_platform::{codex_inputs::CodexInputManifest, provider_environment::CopySelection};
use freshell_runtime_protocol::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) struct Preparation {
    pub(super) manifest_bytes: Vec<u8>,
    pub selections: Vec<CopySelection>,
    pub binds: Vec<ProviderConfigBind>,
    pub mounts: Vec<ProviderResourceMount>,
    pub codex_approval: Option<crate::managed_provider_references::codex::ApprovalProjection>,
}
impl Preparation {
    pub(super) fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }
}
pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    accepted: Option<&CodexInputManifest>,
) -> Result<Preparation, String> {
    let manifest = accepted.cloned().unwrap_or_else(|| CodexInputManifest {
        native_source_runtime: freshell_platform::codex_inputs::NativeSourceRuntime::Tui,
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        codex_home: home.join(".codex"),
        named_profile: None,
    });
    let source = manifest.codex_home.join("config.toml");
    let discovery =
        discover(manifest).map_err(|error| format!("{error}; source {}", source.display()))?;
    let approval = crate::managed_provider_references::codex::approval_projection(&discovery)?;
    let configurations = discovery
        .inputs
        .iter()
        .filter(|input| input.kind == InputKind::Configuration)
        .map(|input| (input.logical_path.clone(), input.canonical_source.clone()))
        .collect();
    let mut ordinary = discovery.resource_roots.clone();
    for input in &discovery.inputs {
        if input.kind != InputKind::Configuration
            && !ordinary
                .iter()
                .any(|root| input.logical_path.starts_with(root))
        {
            ordinary.push(input.logical_path.clone());
        }
    }
    let mut preparation = prepare_selected(
        "codex",
        &discovery.manifest.cwd,
        &discovery.manifest,
        configurations,
        ordinary,
        |logical| discovery.manifest.runtime_path(logical),
    )?;
    preparation.codex_approval = approval;
    Ok(preparation)
}

pub(super) fn prepare_selected<M: serde::Serialize>(
    provider: &str,
    cwd: &Path,
    manifest: &M,
    configurations: Vec<(PathBuf, PathBuf)>,
    mut ordinary: Vec<PathBuf>,
    runtime_path: impl Fn(&Path) -> PathBuf,
) -> Result<Preparation, String> {
    let mut result = Preparation {
        manifest_bytes: bounded_json_bytes(manifest, 64 * 1024 * 1024)
            .map_err(|_| "ordinary source metadata budget exceeded")?,
        selections: Vec::new(),
        binds: Vec::new(),
        mounts: Vec::new(),
        codex_approval: None,
    };
    let mut files = BTreeMap::<PathBuf, String>::new();
    for (logical_path, canonical_source) in configurations {
        let next = files.len();
        let source = files.entry(canonical_source.clone()).or_insert_with(|| {
            let relative = format!(".freshell/templates/{provider}-{next}");
            result.selections.push(CopySelection {
                source: canonical_source.clone(),
                destination_relative: relative.clone().into(),
            });
            relative
        });
        for destination in destinations(&runtime_path, &logical_path) {
            let bind = ProviderConfigBind {
                source_relative_path: source.clone(),
                logical_destination: destination
                    .to_str()
                    .ok_or("Codex config destination is not UTF-8")?
                    .into(),
                effective_destination: effective(&destination, &canonical_source, cwd)
                    .to_str()
                    .ok_or("Codex config destination is not UTF-8")?
                    .into(),
            };
            if !result.binds.contains(&bind) {
                result.binds.push(bind);
            }
        }
    }
    ordinary.sort();
    ordinary.dedup();
    let mut units = BTreeMap::<PathBuf, (String, ProviderResourceKind)>::new();
    for logical in ordinary {
        let source = std::fs::canonicalize(&logical)
            .map_err(|_| "Codex selected resource is missing, inaccessible or cyclic")?;
        let metadata = std::fs::metadata(&source)
            .map_err(|_| "Codex selected resource metadata unavailable")?;
        let kind = if metadata.is_dir() {
            ProviderResourceKind::Directory
        } else if metadata.is_file() {
            ProviderResourceKind::File
        } else {
            return Err("Codex selected resource has an unsupported type".into());
        };
        let next = units.len();
        let (name, _) = units.entry(source.clone()).or_insert_with(|| {
            let name = if kind == ProviderResourceKind::File {
                format!("root-{next}/source")
            } else {
                format!("root-{next}")
            };
            result.selections.push(CopySelection {
                source: source.clone(),
                destination_relative: format!(".freshell/resource-units/{name}").into(),
            });
            (name, kind)
        });
        for destination in destinations(&runtime_path, &logical) {
            result.mounts.push(ProviderResourceMount {
                stage_relative_path: format!(".freshell/resource-units/{name}"),
                provider_relative_path: format!(".freshell/provider-roots/{name}"),
                logical_destination: destination
                    .to_str()
                    .ok_or("Codex resource destination is not UTF-8")?
                    .into(),
                effective_destination: effective(&destination, &source, cwd)
                    .to_str()
                    .ok_or("Codex resource destination is not UTF-8")?
                    .into(),
                kind,
                writable: false,
                reference_aliases: Vec::new(),
                retired_reference_aliases: vec![],
            });
        }
    }
    Ok(result)
}
pub(super) fn stage_codex_approval(root: &Path, preparation: &Preparation) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let Some(projection) = &preparation.codex_approval else {
        return Ok(());
    };
    for source in &projection.sources {
        let selected = preparation
            .selections
            .iter()
            .find(|selection| selection.source == source.canonical)
            .ok_or("Codex approval_policy prepared source is unavailable")?;
        let destination = root.join(&selected.destination_relative);
        let bytes = std::fs::read(&destination).map_err(|_| {
            format!(
                "Codex approval_policy prepared source unreadable: {}",
                source.canonical.display()
            )
        })?;
        if bytes.len() as u64 > freshell_platform::provider_input_profiles::MAX_SOURCE_VIEW_BYTES
            || format!("{:x}", Sha256::digest(&bytes)) != source.sha256
        {
            return Err(format!(
                "Codex approval_policy source changed during preparation: {}",
                source.canonical.display()
            ));
        }
        if !source.strip_untrusted {
            continue;
        }
        let mut value: toml::Value = toml::from_str(
            std::str::from_utf8(&bytes).map_err(|_| "Codex approval_policy source is not UTF-8")?,
        )
        .map_err(|_| "Codex approval_policy source TOML is invalid")?;
        let table = value
            .as_table_mut()
            .ok_or("Codex approval_policy source must be a TOML table")?;
        if table.get("approval_policy").and_then(toml::Value::as_str) != Some("untrusted") {
            return Err(format!(
                "Codex approval_policy source no longer declares the accepted policy: {}",
                source.canonical.display()
            ));
        }
        table.remove("approval_policy");
        let rewritten = toml::to_string(&value)
            .map_err(|_| "Codex approval_policy prepared TOML could not be encoded")?;
        super::replace_staged_private_bytes(&destination, rewritten.as_bytes())?;
    }
    write_private_bytes(
        &root.join(".freshell/codex-approval.json"),
        &bounded_json_bytes(&projection.default, 16 * 1024)
            .map_err(|_| "Codex approval source metadata exceeds control budget")?,
    )?;
    tracing::info!(event="provider.codex.approval_projected", policy=%projection.default.policy,
        source=%projection.default.logical_source, transformed_sources=projection.sources.len());
    Ok(())
}

fn destinations(runtime_path: &impl Fn(&Path) -> PathBuf, logical: &Path) -> Vec<PathBuf> {
    let runtime = runtime_path(logical);
    if runtime == logical {
        vec![runtime]
    } else {
        vec![runtime, logical.into()]
    }
}
fn effective(destination: &Path, canonical: &Path, cwd: &Path) -> PathBuf {
    if destination.starts_with(cwd) && !destination.starts_with("/home/freshell/provider") {
        canonical.into()
    } else {
        destination.into()
    }
}
pub(super) fn publish(
    root: &Path,
    preparation: &Preparation,
    capability: &McpCapabilityReference,
    initial_reservation: Option<&str>,
) -> Result<PreparedProviderInputs, String> {
    use sha2::{Digest, Sha256};
    private_directory(&root.join(".freshell"))?;
    let bytes = &preparation.manifest_bytes;
    write_private_bytes(&root.join(".freshell/input-manifest.json"), bytes)?;
    let inputs = PreparedProviderInputs {
        generation_id: capability.grant_id.clone(),
        initial_auth_reservation: initial_reservation.map(str::to_string),
        manifest: ProviderInputManifestReference {
            relative_path: ".freshell/input-manifest.json".into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            source_count: 0,
            alias_count: 0,
            recipe_count: 0,
        },
        config_binds: preparation.binds.clone(),
        resource_mounts: preparation.mounts.clone(),
        indexed_files: None,
    };
    inputs
        .validate(Some(capability))
        .map_err(|error| error.message)?;
    Ok(inputs)
}
