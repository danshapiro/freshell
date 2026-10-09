//! Existing Amplifier projections share the ordinary manifest/copier boundary.
use super::ordinary_stage::{prepare_selected, Preparation};
use freshell_platform::{
    amplifier_inputs::AmplifierInputManifest, provider_environment::CopySelection,
};
use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};
use std::path::Path;

pub(super) const PROJECTED: &str = ".freshell/resource-units/amplifier-projected";

/// The accepted ordinary stage remains authoritative when its original root
/// is unavailable. Preserve its exact selected routes and complete resource
/// closure; native session state and credential files never enter this stage.
pub(super) fn prepare_retained(
    accepted: &AmplifierInputManifest,
    prior_stage: &Path,
) -> Result<Preparation, String> {
    use freshell_runtime_protocol::{ProviderLaunchContext, MAX_CONTROL_FRAME_BYTES};
    use sha2::{Digest, Sha256};
    accepted.validate().map_err(str::to_string)?;
    let context: ProviderLaunchContext = serde_json::from_slice(&super::read_prepared_metadata(
        prior_stage,
        ".freshell/prepared-context.json",
        MAX_CONTROL_FRAME_BYTES,
    )?)
    .map_err(|_| "Amplifier retained context invalid; retain inputs and reprepare")?;
    context
        .validate("amplifier")
        .map_err(|error| error.message)?;
    let inputs = context
        .prepared_inputs
        .ok_or("Amplifier retained inputs unavailable")?;
    if prior_stage.file_name().and_then(|name| name.to_str()) != Some(&inputs.generation_id) {
        return Err("Amplifier retained generation changed".into());
    }
    let manifest_bytes = super::read_prepared_metadata(
        prior_stage,
        &inputs.manifest.relative_path,
        64 * 1024 * 1024,
    )?;
    if format!("{:x}", Sha256::digest(&manifest_bytes)) != inputs.manifest.sha256 {
        return Err("Amplifier retained source manifest changed".into());
    }
    let prior: AmplifierInputManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "Amplifier retained source manifest invalid")?;
    prior.validate().map_err(str::to_string)?;
    if prior.original_home != accepted.original_home
        || prior.cwd != accepted.cwd
        || prior.workspace != accepted.workspace
    {
        return Err("Amplifier retained original origins changed".into());
    }
    let mut selections = Vec::new();
    let mut paths = std::collections::BTreeSet::new();
    for relative in inputs
        .config_binds
        .iter()
        .map(|bind| &bind.source_relative_path)
        .chain(
            inputs
                .resource_mounts
                .iter()
                .map(|mount| &mount.stage_relative_path),
        )
    {
        if !paths.insert(relative) {
            continue;
        }
        let source = std::fs::canonicalize(prior_stage.join(relative))
            .map_err(|_| "Amplifier retained selected source unavailable")?;
        if !source.starts_with(prior_stage) {
            return Err("Amplifier retained selected source escaped its stage".into());
        }
        selections.push(CopySelection {
            source,
            destination_relative: relative.into(),
        });
    }
    Ok(Preparation {
        manifest_bytes,
        selections,
        binds: inputs.config_binds,
        mounts: inputs.resource_mounts,
    })
}

pub(super) fn prepare(
    home: &Path,
    cwd: &Path,
    workspace: &Path,
    accepted: Option<&AmplifierInputManifest>,
) -> Result<Preparation, String> {
    let manifest = accepted.cloned().unwrap_or_else(|| AmplifierInputManifest {
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        workspace: workspace.into(),
    });
    manifest.validate().map_err(str::to_string)?;
    let references = super::provider_source_references("amplifier", &manifest.original_home)?;
    let mut configurations = Vec::new();
    let mut resources = Vec::new();
    for reference in references {
        if reference.relative_path == ".freshell/resources" {
            continue;
        }
        let logical = manifest
            .original_home
            .join(".amplifier")
            .join(&reference.relative_path);
        let canonical = std::fs::canonicalize(&logical).map_err(|error| {
            format!(
                "Amplifier selected source {} unavailable: {error}",
                logical.display()
            )
        })?;
        if std::fs::metadata(&canonical)
            .map_err(|error| {
                format!(
                    "Amplifier selected source {} metadata failed: {error}",
                    logical.display()
                )
            })?
            .is_dir()
        {
            resources.push(logical);
        } else {
            configurations.push((logical, canonical));
        }
    }
    let mut prepared = prepare_selected(
        "amplifier",
        &manifest.cwd,
        &manifest,
        configurations,
        resources,
        |logical| manifest.runtime_path(logical),
    )?;
    prepared.mounts.push(ProviderResourceMount {
        stage_relative_path: PROJECTED.into(),
        provider_relative_path: ".freshell/provider-roots/amplifier-projected".into(),
        logical_destination: "/home/freshell/provider/.freshell/resources".into(),
        effective_destination: "/home/freshell/provider/.freshell/resources".into(),
        kind: ProviderResourceKind::Directory,
    });
    Ok(prepared)
}

pub(super) fn projected_path(path: &Path) -> Result<std::path::PathBuf, String> {
    Ok(Path::new(PROJECTED).join(
        path.strip_prefix(".freshell/resources")
            .map_err(|_| "Amplifier projected source path escaped its finite root")?,
    ))
}
