use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::controller_command::{DeployCommand, ServerAssemblySources};
use crate::error::{DeployError, Result};
use crate::journal::UpdateMode;
use crate::legacy::{
    validate_release_runtime_sources, LegacyRuntimeSources, NodePrerequisite, RuntimeBindings,
};
use crate::paths::validate_relative_path;
use crate::process_identity::RuntimeProvenance;
use crate::store::{Generation, GenerationStage, Store};

const DESCRIPTOR_FILE: &str = "deployment.json";
const CLIENT_ASSET_PROVENANCE_FILE: &str = "client/.freshell-asset-provenance.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientAssetProvenance {
    schema_version: String,
    owned_assets: Vec<String>,
}

impl ClientAssetProvenance {
    fn from_candidate(candidate: &Path) -> Result<Self> {
        match fs::symlink_metadata(candidate.join(".freshell-asset-provenance.json")) {
            Ok(_) => {
                return Err(DeployError::InvalidReceipt(
                    "candidate client contains the reserved asset provenance file".to_string(),
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut owned_assets = Vec::new();
        collect_asset_files(&candidate.join("assets"), Path::new(""), &mut owned_assets)?;
        owned_assets.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
        let provenance = Self {
            schema_version: "1".to_string(),
            owned_assets,
        };
        provenance.validate()?;
        Ok(provenance)
    }

    fn read(prior: &Generation) -> Result<Option<Self>> {
        let path = prior.path.join(CLIENT_ASSET_PROVENANCE_FILE);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.mode() & 0o7777 != 0o444
        {
            return Err(DeployError::InvalidReceipt(
                "client asset provenance is not an immutable regular file".to_string(),
            ));
        }
        let provenance: Self = serde_json::from_slice(&fs::read(path)?)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        provenance.validate()?;
        Ok(Some(provenance))
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != "1" {
            return Err(DeployError::InvalidReceipt(
                "client asset provenance schemaVersion must be \"1\"".to_string(),
            ));
        }
        let mut prior: Option<&str> = None;
        for asset in &self.owned_assets {
            validate_relative_path(Path::new(asset), false)?;
            if prior.is_some_and(|previous| previous.as_bytes() >= asset.as_bytes()) {
                return Err(DeployError::InvalidReceipt(
                    "client asset provenance paths must be unique and bytewise sorted".to_string(),
                ));
            }
            prior = Some(asset);
        }
        Ok(())
    }

    fn to_json(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationDescriptor {
    pub schema_version: String,
    pub controller_executable: String,
    pub runtime: RuntimeBindings,
    pub node: NodePrerequisite,
}

impl GenerationDescriptor {
    pub fn read(generation: &Generation) -> Result<Self> {
        let path = generation.path.join(DESCRIPTOR_FILE);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.mode() & 0o7777 != 0o444
        {
            return Err(DeployError::InvalidReceipt(
                "generation deployment descriptor is not an immutable regular file".to_string(),
            ));
        }
        let descriptor: Self = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        descriptor.validate(&generation.path)?;
        Ok(descriptor)
    }

    pub fn runtime_provenance(&self, root: &Path) -> RuntimeProvenance {
        RuntimeProvenance {
            client_dir: root.join(&self.runtime.client_dir).display().to_string(),
            extensions_dir: root
                .join(&self.runtime.extensions_dir)
                .display()
                .to_string(),
            dist_server_dir: root
                .join(&self.runtime.dist_server_dir)
                .display()
                .to_string(),
            mcp_entry: root.join(&self.runtime.mcp_entry).display().to_string(),
            claude_sidecar_entry: root
                .join(&self.runtime.claude_sidecar_entry)
                .display()
                .to_string(),
            node_executable: self.node.executable.display().to_string(),
            package_json: root.join(&self.runtime.package_json).display().to_string(),
            package_lock: root.join(&self.runtime.package_lock).display().to_string(),
            production_node_modules: root
                .join(&self.runtime.production_node_modules)
                .display()
                .to_string(),
        }
    }

    pub fn server_executable(&self, root: &Path) -> PathBuf {
        root.join(&self.runtime.server_executable)
    }

    pub fn controller(&self, root: &Path) -> PathBuf {
        root.join(&self.controller_executable)
    }

    fn managed(node: NodePrerequisite, sources: &ServerAssemblySources) -> Result<Self> {
        let mcp = Path::new("dist/server").join(&sources.mcp_entry_relative);
        let sidecar = Path::new("claude-sidecar").join(&sources.claude_sidecar_entry_relative);
        let descriptor = Self {
            schema_version: "1".to_string(),
            controller_executable: "controller/freshell-deploy".to_string(),
            runtime: RuntimeBindings {
                server_executable: "server/freshell-server".to_string(),
                client_dir: "client".to_string(),
                extensions_dir: "extensions".to_string(),
                dist_server_dir: "dist/server".to_string(),
                mcp_entry: path_string(&mcp)?,
                claude_sidecar_entry: path_string(&sidecar)?,
                package_json: "package.json".to_string(),
                package_lock: "package-lock.json".to_string(),
                production_node_modules: "node_modules".to_string(),
            },
            node,
        };
        Ok(descriptor)
    }

    fn validate(&self, root: &Path) -> Result<()> {
        if self.schema_version != "1"
            || !self.node.executable.is_absolute()
            || self.node.version.is_empty()
        {
            return Err(DeployError::InvalidReceipt(
                "generation deployment descriptor is incomplete".to_string(),
            ));
        }
        for relative in [
            &self.controller_executable,
            &self.runtime.server_executable,
            &self.runtime.client_dir,
            &self.runtime.extensions_dir,
            &self.runtime.dist_server_dir,
            &self.runtime.mcp_entry,
            &self.runtime.claude_sidecar_entry,
            &self.runtime.package_json,
            &self.runtime.package_lock,
            &self.runtime.production_node_modules,
        ] {
            validate_relative_path(Path::new(relative), false)?;
        }
        for (relative, directory) in [
            (&self.controller_executable, false),
            (&self.runtime.server_executable, false),
            (&self.runtime.client_dir, true),
            (&self.runtime.extensions_dir, true),
            (&self.runtime.dist_server_dir, true),
            (&self.runtime.mcp_entry, false),
            (&self.runtime.claude_sidecar_entry, false),
            (&self.runtime.package_json, false),
            (&self.runtime.package_lock, false),
            (&self.runtime.production_node_modules, true),
        ] {
            let path = root.join(relative);
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink()
                || (directory && !metadata.is_dir())
                || (!directory && !metadata.is_file())
            {
                return Err(DeployError::InvalidReceipt(format!(
                    "generation descriptor path has the wrong type: {}",
                    path.display()
                )));
            }
        }
        let node = fs::symlink_metadata(&self.node.executable)?;
        if node.file_type().is_symlink() || !node.is_file() || node.mode() & 0o111 == 0 {
            return Err(DeployError::InvalidReceipt(
                "generation Node prerequisite is not an executable regular file".to_string(),
            ));
        }
        Ok(())
    }

    fn to_json(&self) -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec(self)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

pub fn assemble_generation(store: &Store, command: &DeployCommand) -> Result<Generation> {
    if store.paths().checkout() != command.checkout || store.paths().port() != command.port {
        return Err(DeployError::InvalidReceipt(
            "assembly command does not match the opened deployment store".to_string(),
        ));
    }
    let selected_id = store.selected_generation_id()?.ok_or_else(|| {
        DeployError::InvalidReceipt(
            "a selected prior generation is required before assembly".to_string(),
        )
    })?;
    let prior = store.verify_generation(&selected_id)?;
    let prior_descriptor = GenerationDescriptor::read(&prior);
    if command.mode != UpdateMode::Full && prior_descriptor.is_err() {
        return Err(DeployError::Activation(
            "one-sided updates are unavailable until combined bootstrap completes".to_string(),
        ));
    }

    let locked = store.lock()?;
    if store.selected_generation_id()?.as_deref() != Some(selected_id.as_str()) {
        return Err(DeployError::Activation(
            "selected generation changed before private assembly".to_string(),
        ));
    }
    let mut stage = locked.begin_generation()?;
    match command.mode {
        UpdateMode::ClientOnly => {
            let descriptor = prior_descriptor?;
            let client = command
                .client_dir
                .as_deref()
                .expect("parsed client-only command has client");
            let provenance = ClientAssetProvenance::from_candidate(client)?;
            if command.node != descriptor.node {
                return Err(DeployError::Activation(
                    "client-only update must retain the selected server Node prerequisite"
                        .to_string(),
                ));
            }
            copy_managed_server_closure(&mut stage, &prior)?;
            copy_candidate_client(&mut stage, client, &prior)?;
            stage.write_bytes(
                Path::new(CLIENT_ASSET_PROVENANCE_FILE),
                &provenance.to_json()?,
                0o644,
            )?;
            stage.write_bytes(Path::new(DESCRIPTOR_FILE), &descriptor.to_json()?, 0o644)?;
        }
        UpdateMode::Server => {
            let descriptor = prior_descriptor?;
            stage.copy_generation_tree(&prior, Path::new("client"), Path::new("client"))?;
            let sources = command
                .server
                .as_ref()
                .expect("parsed server command has sources");
            copy_server_sources(&mut stage, sources, &command.node)?;
            let target_descriptor = GenerationDescriptor::managed(command.node.clone(), sources)?;
            // The prior descriptor read above proves this is a managed
            // generation; its Node prerequisite may intentionally advance
            // with the new server runtime.
            let _ = descriptor;
            stage.write_bytes(
                Path::new(DESCRIPTOR_FILE),
                &target_descriptor.to_json()?,
                0o644,
            )?;
        }
        UpdateMode::Full => {
            let client = command
                .client_dir
                .as_deref()
                .expect("parsed full command has client");
            let provenance = ClientAssetProvenance::from_candidate(client)?;
            stage.copy_tree(client, Path::new("client"))?;
            stage.write_bytes(
                Path::new(CLIENT_ASSET_PROVENANCE_FILE),
                &provenance.to_json()?,
                0o644,
            )?;
            let sources = command
                .server
                .as_ref()
                .expect("parsed full command has sources");
            copy_server_sources(&mut stage, sources, &command.node)?;
            let descriptor = GenerationDescriptor::managed(command.node.clone(), sources)?;
            stage.write_bytes(Path::new(DESCRIPTOR_FILE), &descriptor.to_json()?, 0o644)?;
        }
    }
    stage.seal()?;
    locked.publish_or_reuse(stage)
}

fn copy_managed_server_closure(stage: &mut GenerationStage, prior: &Generation) -> Result<()> {
    for directory in [
        "server",
        "controller",
        "extensions",
        "dist",
        "claude-sidecar",
        "node_modules",
    ] {
        stage.copy_generation_tree(prior, Path::new(directory), Path::new(directory))?;
    }
    for file in ["package.json", "package-lock.json"] {
        stage.copy_generation_file(prior, Path::new(file), Path::new(file))?;
    }
    Ok(())
}

fn copy_candidate_client(
    stage: &mut GenerationStage,
    candidate: &Path,
    prior: &Generation,
) -> Result<()> {
    stage.copy_tree(candidate, Path::new("client"))?;
    match ClientAssetProvenance::read(prior)? {
        Some(provenance) => {
            for asset in provenance.owned_assets {
                stage
                    .merge_generation_asset_file(prior, &Path::new("client/assets").join(asset))?;
            }
        }
        None if prior.path.join("client/assets").exists() => {
            // Generations created before asset provenance was introduced get
            // one conservative handoff. The newly assembled generation then
            // records only its own build assets, bounding later retention.
            stage.merge_generation_assets(
                prior,
                Path::new("client/assets"),
                Path::new("client/assets"),
            )?;
        }
        None => {}
    }
    Ok(())
}

pub(crate) fn required_predecessor_client_assets(prior: &Generation) -> Result<Vec<String>> {
    match ClientAssetProvenance::read(prior)? {
        Some(provenance) => Ok(provenance
            .owned_assets
            .into_iter()
            .map(|asset| {
                Path::new("client/assets")
                    .join(asset)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()),
        None => Ok(prior
            .manifest
            .entries
            .iter()
            .filter(|entry| {
                entry.path.starts_with("client/assets/")
                    && entry.kind == crate::manifest::EntryKind::File
            })
            .map(|entry| entry.path.clone())
            .collect()),
    }
}

fn collect_asset_files(root: &Path, relative: &Path, assets: &mut Vec<String>) -> Result<()> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && relative.as_os_str().is_empty() =>
        {
            return Ok(())
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DeployError::InvalidReceipt(
            "candidate client assets must be a real directory".to_string(),
        ));
    }
    let mut children = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        let child_relative = relative.join(child.file_name());
        let child_path = child.path();
        let child_metadata = fs::symlink_metadata(&child_path)?;
        if child_metadata.file_type().is_symlink() {
            return Err(DeployError::InvalidReceipt(format!(
                "candidate client asset is a symlink: {}",
                child_path.display()
            )));
        }
        if child_metadata.is_dir() {
            collect_asset_files(&child_path, &child_relative, assets)?;
        } else if child_metadata.is_file() {
            assets.push(path_string(&child_relative)?);
        } else {
            return Err(DeployError::InvalidReceipt(format!(
                "candidate client asset is special: {}",
                child_path.display()
            )));
        }
    }
    Ok(())
}

fn copy_server_sources(
    stage: &mut GenerationStage,
    sources: &ServerAssemblySources,
    node: &NodePrerequisite,
) -> Result<()> {
    validate_server_sources(sources)?;
    validate_release_runtime_sources(
        &LegacyRuntimeSources {
            // The client is validated independently and is not part of this
            // server/runtime closure check.
            client_dir: sources.extensions_dir.clone(),
            extensions_dir: sources.extensions_dir.clone(),
            dist_server_dir: sources.dist_server_dir.clone(),
            mcp_entry_relative: sources.mcp_entry_relative.clone(),
            claude_sidecar_dir: sources.claude_sidecar_dir.clone(),
            claude_sidecar_entry_relative: sources.claude_sidecar_entry_relative.clone(),
            package_json: sources.package_json.clone(),
            package_lock: sources.package_lock.clone(),
            production_node_modules: sources.production_node_modules.clone(),
        },
        node,
        false,
    )?;
    stage.copy_file(
        &sources.server_executable,
        Path::new("server/freshell-server"),
        executable_mode(&sources.server_executable)?,
    )?;
    stage.copy_file(
        &sources.controller_executable,
        Path::new("controller/freshell-deploy"),
        executable_mode(&sources.controller_executable)?,
    )?;
    stage.copy_tree(&sources.extensions_dir, Path::new("extensions"))?;
    stage.copy_tree(&sources.dist_server_dir, Path::new("dist/server"))?;
    stage.copy_tree_excluding_top_level(
        &sources.claude_sidecar_dir,
        Path::new("claude-sidecar"),
        Path::new("node_modules"),
    )?;
    stage.copy_file(
        &sources.package_json,
        Path::new("package.json"),
        source_mode(&sources.package_json)?,
    )?;
    stage.copy_file(
        &sources.package_lock,
        Path::new("package-lock.json"),
        source_mode(&sources.package_lock)?,
    )?;
    stage.copy_tree(&sources.production_node_modules, Path::new("node_modules"))?;
    validate_release_runtime_sources(
        &LegacyRuntimeSources {
            client_dir: stage.path().join("client"),
            extensions_dir: stage.path().join("extensions"),
            dist_server_dir: stage.path().join("dist/server"),
            mcp_entry_relative: sources.mcp_entry_relative.clone(),
            claude_sidecar_dir: stage.path().join("claude-sidecar"),
            claude_sidecar_entry_relative: sources.claude_sidecar_entry_relative.clone(),
            package_json: stage.path().join("package.json"),
            package_lock: stage.path().join("package-lock.json"),
            production_node_modules: stage.path().join("node_modules"),
        },
        node,
        true,
    )?;
    Ok(())
}

fn validate_server_sources(sources: &ServerAssemblySources) -> Result<()> {
    for (label, path, directory) in [
        ("server executable", &sources.server_executable, false),
        (
            "controller executable",
            &sources.controller_executable,
            false,
        ),
        ("extensions", &sources.extensions_dir, true),
        ("compiled server", &sources.dist_server_dir, true),
        ("Claude sidecar", &sources.claude_sidecar_dir, true),
        ("package.json", &sources.package_json, false),
        ("package-lock.json", &sources.package_lock, false),
        (
            "production node_modules",
            &sources.production_node_modules,
            true,
        ),
    ] {
        if !path.is_absolute() {
            return Err(DeployError::InvalidReceipt(format!(
                "{label} source is not absolute"
            )));
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink()
            || (directory && !metadata.is_dir())
            || (!directory && !metadata.is_file())
        {
            return Err(DeployError::InvalidReceipt(format!(
                "{label} source has the wrong type"
            )));
        }
    }
    for relative in [
        &sources.mcp_entry_relative,
        &sources.claude_sidecar_entry_relative,
    ] {
        validate_relative_path(relative, false)?;
    }
    for path in [
        sources.dist_server_dir.join(&sources.mcp_entry_relative),
        sources
            .claude_sidecar_dir
            .join(&sources.claude_sidecar_entry_relative),
    ] {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(DeployError::InvalidReceipt(format!(
                "runtime entry has the wrong type: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn source_mode(path: &Path) -> Result<u32> {
    Ok(fs::symlink_metadata(path)?.mode() & 0o7777)
}

fn executable_mode(path: &Path) -> Result<u32> {
    let mode = source_mode(path)?;
    if mode & 0o111 == 0 {
        return Err(DeployError::InvalidReceipt(format!(
            "runtime executable lacks execute permission: {}",
            path.display()
        )));
    }
    Ok(mode)
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str().map(str::to_string).ok_or_else(|| {
        DeployError::InvalidReceipt(format!("runtime path is not UTF-8: {}", path.display()))
    })
}
