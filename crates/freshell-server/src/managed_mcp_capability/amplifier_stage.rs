//! Existing Amplifier projections share the ordinary manifest/copier boundary.
use super::ordinary_stage::{prepare_selected, Preparation};
use freshell_platform::amplifier_inputs::AmplifierInputManifest;
use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};
use std::path::Path;

pub(super) const PROJECTED: &str = ".freshell/resource-units/amplifier-projected";

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
