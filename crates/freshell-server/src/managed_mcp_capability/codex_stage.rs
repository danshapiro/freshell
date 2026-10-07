//! Native-selected ordinary Codex inputs use the shared resource copier and
//! existing exact mounts. No configuration payload enters callback metadata.
use super::{private_directory, write_private_bytes};
use crate::managed_provider_references::codex::{discover, Discovery, InputKind};
use freshell_platform::{codex_inputs::CodexInputManifest, provider_environment::CopySelection};
use freshell_runtime_protocol::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) struct Preparation {
    pub discovery: Discovery,
    pub selections: Vec<CopySelection>,
    pub binds: Vec<ProviderConfigBind>,
    pub mounts: Vec<ProviderResourceMount>,
}
pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    accepted: Option<&CodexInputManifest>,
) -> Result<Preparation, String> {
    let manifest = accepted.cloned().unwrap_or_else(|| CodexInputManifest {
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        codex_home: home.join(".codex"),
        named_profile: None,
    });
    let discovery = discover(manifest).map_err(str::to_string)?;
    let mut result = Preparation {
        discovery,
        selections: Vec::new(),
        binds: Vec::new(),
        mounts: Vec::new(),
    };
    let mut files = BTreeMap::<PathBuf, String>::new();
    for input in &result.discovery.inputs {
        if input.kind != InputKind::Configuration {
            continue;
        }
        let next = files.len();
        let source = files
            .entry(input.canonical_source.clone())
            .or_insert_with(|| {
                let relative = format!(".freshell/templates/codex-{next}");
                result.selections.push(CopySelection {
                    source: input.canonical_source.clone(),
                    destination_relative: relative.clone().into(),
                });
                relative
            });
        for destination in destinations(&result.discovery.manifest, &input.logical_path) {
            let bind = ProviderConfigBind {
                source_relative_path: source.clone(),
                logical_destination: destination
                    .to_str()
                    .ok_or("Codex config destination is not UTF-8")?
                    .into(),
                effective_destination: effective(
                    &destination,
                    &input.canonical_source,
                    &result.discovery.manifest,
                )
                .to_str()
                .ok_or("Codex config destination is not UTF-8")?
                .into(),
            };
            if !result.binds.contains(&bind) {
                result.binds.push(bind);
            }
        }
    }
    let mut ordinary = result.discovery.resource_roots.clone();
    for input in &result.discovery.inputs {
        if input.kind == InputKind::Configuration {
            continue;
        }
        if !ordinary
            .iter()
            .any(|root| input.logical_path.starts_with(root))
        {
            ordinary.push(input.logical_path.clone());
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
        for destination in destinations(&result.discovery.manifest, &logical) {
            result.mounts.push(ProviderResourceMount {
                stage_relative_path: format!(".freshell/resource-units/{name}"),
                provider_relative_path: format!(".freshell/provider-roots/{name}"),
                logical_destination: destination
                    .to_str()
                    .ok_or("Codex resource destination is not UTF-8")?
                    .into(),
                effective_destination: effective(&destination, &source, &result.discovery.manifest)
                    .to_str()
                    .ok_or("Codex resource destination is not UTF-8")?
                    .into(),
                kind,
            });
        }
    }
    Ok(result)
}
fn destinations(manifest: &CodexInputManifest, logical: &Path) -> Vec<PathBuf> {
    let runtime = manifest.runtime_path(logical);
    if runtime == logical {
        vec![runtime]
    } else {
        vec![runtime, logical.into()]
    }
}
fn effective(destination: &Path, canonical: &Path, manifest: &CodexInputManifest) -> PathBuf {
    if destination.starts_with(&manifest.cwd) && !destination.starts_with("/home/freshell/provider")
    {
        canonical.into()
    } else {
        destination.into()
    }
}
pub(super) fn publish(
    root: &Path,
    preparation: &Preparation,
    capability: &McpCapabilityReference,
) -> Result<PreparedProviderInputs, String> {
    use sha2::{Digest, Sha256};
    private_directory(&root.join(".freshell"))?;
    let bytes = bounded_json_bytes(&preparation.discovery.manifest, 64 * 1024 * 1024)
        .map_err(|_| "Codex source metadata budget exceeded")?;
    write_private_bytes(&root.join(".freshell/input-manifest.json"), &bytes)?;
    let inputs = PreparedProviderInputs {
        generation_id: capability.grant_id.clone(),
        initial_auth_reservation: None,
        manifest: ProviderInputManifestReference {
            relative_path: ".freshell/input-manifest.json".into(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
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
