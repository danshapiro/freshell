use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::ops::{Deref, DerefMut};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::bounded_http::{get as bounded_http_get, HttpLimits};
use crate::durable::sync_directory;
use crate::error::{DeployError, Result};
use crate::manifest::{sha256_file, snapshot_tree_entries, ManifestEntry};
use crate::paths::{validate_relative_path, validate_symlink_target, DeployPort};
use crate::process_identity::{LinuxProcfs, PinnedProcess, ProcessIdentity, ProcessInspector};
use crate::receipts::validate_generation_id;
use crate::receipts::LiveReceipt;
use crate::store::Store;

#[derive(Debug, Clone)]
pub struct LegacyRuntimeSources {
    pub client_dir: PathBuf,
    pub extensions_dir: PathBuf,
    pub dist_server_dir: PathBuf,
    pub mcp_entry_relative: PathBuf,
    pub claude_sidecar_dir: PathBuf,
    pub claude_sidecar_entry_relative: PathBuf,
    pub package_json: PathBuf,
    pub package_lock: PathBuf,
    pub production_node_modules: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePrerequisite {
    pub executable: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct LegacyCaptureRequest {
    pub pid_hint: u32,
    pub port: DeployPort,
    pub runtime: LegacyRuntimeSources,
    pub node: NodePrerequisite,
    pub controller_executable: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeBindings {
    pub server_executable: String,
    pub client_dir: String,
    pub extensions_dir: String,
    pub dist_server_dir: String,
    pub mcp_entry: String,
    pub claude_sidecar_entry: String,
    pub package_json: String,
    pub package_lock: String,
    pub production_node_modules: String,
}

impl RuntimeBindings {
    fn legacy_layout(sources: &LegacyRuntimeSources) -> Result<Self> {
        Ok(Self {
            server_executable: "server/freshell-server".to_string(),
            client_dir: "client".to_string(),
            extensions_dir: "extensions".to_string(),
            dist_server_dir: "dist/server".to_string(),
            mcp_entry: binding_path(Path::new("dist/server"), &sources.mcp_entry_relative)?,
            claude_sidecar_entry: binding_path(
                Path::new("claude-sidecar"),
                &sources.claude_sidecar_entry_relative,
            )?,
            package_json: "package.json".to_string(),
            package_lock: "package-lock.json".to_string(),
            production_node_modules: "node_modules".to_string(),
        })
    }
}

fn binding_path(base: &Path, relative: &Path) -> Result<String> {
    base.join(relative)
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "runtime binding path is not UTF-8: {}",
                relative.display()
            ))
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NonSecretLaunchMetadata {
    /// Observed process-identity evidence only. A rollback launcher must use
    /// the selected generation root as cwd so legacy relative runtime
    /// discovery cannot fall back to the mutable checkout recorded here.
    pub cwd: String,
    pub argv0: String,
    pub argument_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyCaptureReceipt {
    pub schema_version: String,
    pub generation_id: String,
    pub legacy: bool,
    pub process: ProcessIdentity,
    pub runtime: RuntimeBindings,
    pub node: NodePrerequisite,
    pub launch: NonSecretLaunchMetadata,
}

impl LegacyCaptureReceipt {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.schema_version != "1" {
            return Err(DeployError::InvalidReceipt(
                "legacy schemaVersion must be \"1\"".to_string(),
            ));
        }
        if !self.legacy {
            return Err(DeployError::InvalidReceipt(
                "legacy capture receipt must set legacy=true".to_string(),
            ));
        }
        validate_generation_id(&self.generation_id)?;
        validate_node_prerequisite(&self.node)?;
        self.process.validate().map_err(|error| {
            DeployError::InvalidReceipt(format!("legacy process identity is invalid: {error}"))
        })?;
        for path in [
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
            validate_relative_path(Path::new(path), false)
                .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        }
        if self.launch.cwd.is_empty()
            || self.launch.argv0.is_empty()
            || self.launch.cwd != self.process.cwd
            || self.launch.argv0 != self.process.argv0
            || self.launch.argument_count != self.process.argument_count
        {
            return Err(DeployError::InvalidReceipt(
                "legacy process/launch identity is incomplete or inconsistent".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn from_json(bytes: &[u8]) -> Result<Self> {
        let receipt: Self = serde_json::from_slice(bytes)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        receipt.validate()?;
        Ok(receipt)
    }

    pub(crate) fn to_json(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut bytes = serde_json::to_vec(self)
            .map_err(|error| DeployError::InvalidReceipt(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

#[derive(Debug, Clone)]
pub struct ScratchProbeRequest {
    pub generation_path: PathBuf,
    pub generation_id: String,
    pub isolated_home: PathBuf,
    pub port: u16,
    pub runtime: RuntimeBindings,
    pub node: NodePrerequisite,
}

impl ScratchProbeRequest {
    fn resolve(&self, relative: &str) -> PathBuf {
        self.generation_path.join(relative)
    }

    pub fn server_executable(&self) -> PathBuf {
        self.resolve(&self.runtime.server_executable)
    }

    pub fn client_dir(&self) -> PathBuf {
        self.resolve(&self.runtime.client_dir)
    }

    pub fn extensions_dir(&self) -> PathBuf {
        self.resolve(&self.runtime.extensions_dir)
    }

    pub fn mcp_entry(&self) -> PathBuf {
        self.resolve(&self.runtime.mcp_entry)
    }

    pub fn legacy_mcp_fallback_entry(&self) -> PathBuf {
        self.generation_path.join("dist/server/mcp/server.js")
    }

    pub fn claude_sidecar_entry(&self) -> PathBuf {
        self.resolve(&self.runtime.claude_sidecar_entry)
    }

    pub fn production_node_modules(&self) -> PathBuf {
        self.resolve(&self.runtime.production_node_modules)
    }
}

pub trait ScratchProbe {
    fn verify(&self, request: &ScratchProbeRequest) -> Result<()>;
}

pub fn capture_legacy<Inspector: ProcessInspector, Probe: ScratchProbe>(
    store: &Store,
    request: &LegacyCaptureRequest,
    inspector: &Inspector,
    probe: &Probe,
) -> Result<LegacyCaptureReceipt> {
    if request.port != store.paths().port() {
        return Err(DeployError::LegacyCapture(format!(
            "requested capture port {} does not match store port {}",
            request.port,
            store.paths().port()
        )));
    }
    let locked = store.lock()?;
    let prefix = inspect_legacy_bootstrap_prefix(store)?;
    validate_runtime_sources(&request.runtime)?;
    let source_runtime = RuntimeSourceSnapshots::from_sources(&request.runtime)?;
    let source_dependencies = RuntimeDependencySnapshots::from_sources(&request.runtime)?;
    validate_node_prerequisite(&request.node)?;
    let pinned = PinnedProcess::pin(inspector, request.pid_hint, request.port)?;
    let process = pinned.identity().clone();
    if Path::new(&process.cwd) != store.paths().checkout() {
        return Err(DeployError::LegacyCapture(format!(
            "listener owner cwd {} does not match canonical checkout {}",
            process.cwd,
            store.paths().checkout().display()
        )));
    }
    verify_live_runtime_sources(&process, request)?;
    verify_live_client(&pinned, &request.runtime.client_dir)?;
    let mut executable = pinned.open_verified_executable()?;

    let bindings = RuntimeBindings::legacy_layout(&request.runtime)?;
    let mut stage = locked.begin_generation()?;
    stage.copy_open_file(
        &mut executable,
        Path::new(&bindings.server_executable),
        process.executable.mode,
    )?;
    stage.copy_tree(&request.runtime.client_dir, Path::new(&bindings.client_dir))?;
    stage.copy_tree(
        &request.runtime.extensions_dir,
        Path::new(&bindings.extensions_dir),
    )?;
    stage.copy_tree(
        &request.runtime.dist_server_dir,
        Path::new(&bindings.dist_server_dir),
    )?;
    stage.copy_file(
        &request.runtime.package_json,
        Path::new(&bindings.package_json),
        source_mode(&request.runtime.package_json)?,
    )?;
    stage.copy_file(
        &request.runtime.package_lock,
        Path::new(&bindings.package_lock),
        source_mode(&request.runtime.package_lock)?,
    )?;
    stage.copy_tree(
        &request.runtime.production_node_modules,
        Path::new(&bindings.production_node_modules),
    )?;
    stage.copy_tree(
        &request.runtime.claude_sidecar_dir,
        Path::new("claude-sidecar"),
    )?;

    pinned.revalidate()?;
    source_runtime.verify_captured(&request.runtime, stage.path(), &bindings)?;
    source_dependencies.verify_captured(&request.runtime, stage.path(), &bindings)?;
    let generation_id = stage.seal()?.generation_id.clone();
    let scratch = ScratchWorkspace::create(store.paths().generations_dir())?;
    let scratch_request = ScratchProbeRequest {
        generation_path: stage.path().to_path_buf(),
        generation_id: generation_id.clone(),
        isolated_home: scratch.isolated_home().to_path_buf(),
        port: 0,
        runtime: bindings.clone(),
        node: request.node.clone(),
    };
    let probe_result = probe.verify(&scratch_request);
    let cleanup_result = scratch.cleanup();
    combine_scratch_results(probe_result, cleanup_result)?;
    pinned.revalidate()?;
    verify_live_client(&pinned, &request.runtime.client_dir)?;

    let receipt = LegacyCaptureReceipt {
        schema_version: "1".to_string(),
        generation_id: generation_id.clone(),
        legacy: true,
        process: process.clone(),
        runtime: bindings,
        node: request.node.clone(),
        launch: NonSecretLaunchMetadata {
            cwd: process.cwd.clone(),
            argv0: process.argv0.clone(),
            argument_count: process.argument_count,
        },
    };
    if let Some(existing) = &prefix.legacy {
        if existing != &receipt {
            return Err(DeployError::LegacyCapture(
                "existing legacy adoption does not match the verified bootstrap closure"
                    .to_string(),
            ));
        }
    }
    if let Some(selected) = &prefix.selected {
        if selected != &generation_id {
            return Err(DeployError::LegacyCapture(format!(
                "existing legacy adoption selects generation {selected}, not {generation_id}"
            )));
        }
    }

    locked.install_legacy_controller(&request.controller_executable)?;
    let generation = locked.publish_or_reuse(stage)?;
    if prefix.legacy.is_none() {
        locked.write_legacy_capture(&receipt)?;
    }
    if prefix.selected.is_none() {
        locked.select_generation(&generation.id)?;
    }
    pinned.revalidate()?;
    let live = LiveReceipt::new(
        generation.id.clone(),
        Some(generation.id),
        true,
        Some(process),
    );
    if let Some(existing) = &prefix.live {
        if existing != &live {
            return Err(DeployError::LegacyCapture(
                "completed legacy adoption does not match the verified bootstrap closure"
                    .to_string(),
            ));
        }
        sync_directory(store.paths().port_root())?;
        return Ok(receipt);
    }
    locked.write_live(&live)?;
    Ok(receipt)
}

fn verify_live_runtime_sources(
    process: &ProcessIdentity,
    request: &LegacyCaptureRequest,
) -> Result<()> {
    let sidecar_entry = request
        .runtime
        .claude_sidecar_dir
        .join(&request.runtime.claude_sidecar_entry_relative);
    let mcp_entry = request
        .runtime
        .dist_server_dir
        .join(&request.runtime.mcp_entry_relative);
    for (label, supplied, live) in [
        (
            "client",
            request.runtime.client_dir.as_path(),
            process.runtime.client_dir.as_str(),
        ),
        (
            "extensions",
            request.runtime.extensions_dir.as_path(),
            process.runtime.extensions_dir.as_str(),
        ),
        (
            "compiled server",
            request.runtime.dist_server_dir.as_path(),
            process.runtime.dist_server_dir.as_str(),
        ),
        (
            "MCP entry",
            mcp_entry.as_path(),
            process.runtime.mcp_entry.as_str(),
        ),
        (
            "Claude sidecar entry",
            sidecar_entry.as_path(),
            process.runtime.claude_sidecar_entry.as_str(),
        ),
        (
            "package.json",
            request.runtime.package_json.as_path(),
            process.runtime.package_json.as_str(),
        ),
        (
            "package-lock.json",
            request.runtime.package_lock.as_path(),
            process.runtime.package_lock.as_str(),
        ),
        (
            "production dependencies",
            request.runtime.production_node_modules.as_path(),
            process.runtime.production_node_modules.as_str(),
        ),
        (
            "Node",
            request.node.executable.as_path(),
            process.runtime.node_executable.as_str(),
        ),
    ] {
        let supplied = fs::canonicalize(supplied)?;
        if supplied != Path::new(live) {
            return Err(DeployError::LegacyCapture(format!(
                "supplied {label} path {} does not match live process provenance {live}",
                supplied.display()
            )));
        }
    }
    Ok(())
}

fn verify_live_client<Inspector: ProcessInspector>(
    pinned: &PinnedProcess<'_, Inspector>,
    client_dir: &Path,
) -> Result<()> {
    let expected = fs::read(client_dir.join("index.html"))?;
    let actual = pinned.read_live_client()?;
    if actual != expected {
        return Err(DeployError::LegacyCapture(
            "supplied client does not match the bytes served by the live process".to_string(),
        ));
    }
    Ok(())
}

struct LegacyBootstrapPrefix {
    legacy: Option<LegacyCaptureReceipt>,
    selected: Option<String>,
    live: Option<LiveReceipt>,
}

fn inspect_legacy_bootstrap_prefix(store: &Store) -> Result<LegacyBootstrapPrefix> {
    let legacy = store.read_legacy_capture()?;
    let selected = store.selected_generation_id()?;
    let live = store.read_live()?;

    match (&legacy, &selected) {
        (None, Some(selected)) => {
            return Err(DeployError::LegacyCapture(format!(
                "cannot adopt legacy runtime over existing current generation {selected}"
            )));
        }
        (Some(receipt), Some(selected)) if selected != &receipt.generation_id => {
            return Err(DeployError::LegacyCapture(format!(
                "legacy receipt generation {} disagrees with current generation {selected}",
                receipt.generation_id
            )));
        }
        _ => {}
    }
    if let Some(live) = &live {
        let (Some(legacy), Some(selected)) = (&legacy, &selected) else {
            return Err(DeployError::LegacyCapture(
                "completed legacy adoption is missing legacy.json or current".to_string(),
            ));
        };
        if !live.legacy
            || &live.selected_generation_id != selected
            || live.running_server_generation_id.as_deref() != Some(selected)
            || live.process_identity.as_ref() != Some(&legacy.process)
        {
            return Err(DeployError::LegacyCapture(
                "completed legacy adoption receipts are inconsistent".to_string(),
            ));
        }
    }
    if let Some(receipt) = &legacy {
        store.verify_generation(&receipt.generation_id)?;
    }
    if legacy.is_some() || selected.is_some() || live.is_some() {
        sync_directory(store.paths().port_root())?;
    }
    Ok(LegacyBootstrapPrefix {
        legacy,
        selected,
        live,
    })
}

pub(crate) fn legacy_bootstrap_is_incomplete(store: &Store) -> Result<bool> {
    let prefix = inspect_legacy_bootstrap_prefix(store)?;
    Ok(prefix.live.is_none() && (prefix.legacy.is_some() || prefix.selected.is_some()))
}

fn validate_runtime_sources(sources: &LegacyRuntimeSources) -> Result<()> {
    validate_source_directory("client", &sources.client_dir)?;
    validate_server_runtime_sources(sources, true, DependencyClosureKind::ExactLive)?;
    Ok(())
}

fn validate_server_runtime_sources(
    sources: &LegacyRuntimeSources,
    forbid_nested_sidecar_dependencies: bool,
    dependency_closure_kind: DependencyClosureKind,
) -> Result<()> {
    for (label, path) in [
        ("extensions", &sources.extensions_dir),
        ("compiled server", &sources.dist_server_dir),
        ("Claude sidecar", &sources.claude_sidecar_dir),
        ("production dependencies", &sources.production_node_modules),
    ] {
        validate_source_directory(label, path)?;
    }
    expected_extension_names(&sources.extensions_dir)?;
    for (label, path) in [
        ("package manifest", &sources.package_json),
        ("lockfile", &sources.package_lock),
    ] {
        validate_source_file(label, path)?;
    }
    validate_relative_path(&sources.mcp_entry_relative, false)?;
    validate_source_file(
        "MCP entry",
        &sources.dist_server_dir.join(&sources.mcp_entry_relative),
    )?;
    validate_source_file(
        "pre-binding legacy MCP fallback entry",
        &sources.dist_server_dir.join("mcp/server.js"),
    )?;
    validate_relative_path(&sources.claude_sidecar_entry_relative, false)?;
    validate_source_file(
        "Claude sidecar entry",
        &sources
            .claude_sidecar_dir
            .join(&sources.claude_sidecar_entry_relative),
    )?;
    let sidecar_package = sources.claude_sidecar_dir.join("package.json");
    let sidecar_lock = sources.claude_sidecar_dir.join("package-lock.json");
    validate_source_file("Claude sidecar package manifest", &sidecar_package)?;
    validate_source_file("Claude sidecar lockfile", &sidecar_lock)?;
    validate_dependency_closure(
        &sources.package_json,
        &sources.package_lock,
        &sources.production_node_modules,
        dependency_closure_kind,
    )?;
    if forbid_nested_sidecar_dependencies {
        validate_sidecar_shared_dependency_contract(
            &sources.claude_sidecar_dir,
            &sources.package_json,
            &sources.production_node_modules,
        )
    } else {
        validate_dependency_subset(
            &sources.claude_sidecar_dir.join("package.json"),
            &sources.claude_sidecar_dir.join("package-lock.json"),
            &sources.package_json,
            &sources.production_node_modules,
        )
    }
}

pub(crate) fn validate_release_runtime_sources(
    sources: &LegacyRuntimeSources,
    node: &NodePrerequisite,
    forbid_nested_sidecar_dependencies: bool,
) -> Result<()> {
    validate_server_runtime_sources(
        sources,
        forbid_nested_sidecar_dependencies,
        DependencyClosureKind::Production,
    )?;
    validate_node_prerequisite(node)
}

fn validate_source_directory(label: &str, path: &Path) -> Result<()> {
    validate_canonical_source(label, path, true)
}

fn validate_source_file(label: &str, path: &Path) -> Result<()> {
    validate_canonical_source(label, path, false)
}

fn validate_canonical_source(label: &str, path: &Path, directory: bool) -> Result<()> {
    if !path.is_absolute() {
        return Err(DeployError::LegacyCapture(format!(
            "{label} path must be absolute: {}",
            path.display()
        )));
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "{label} is unavailable at {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(DeployError::LegacyCapture(format!(
            "{label} is not a real {}: {}",
            if directory { "directory" } else { "file" },
            path.display()
        )));
    }
    let canonical = fs::canonicalize(path)?;
    if canonical != path {
        return Err(DeployError::LegacyCapture(format!(
            "{label} path is not canonical: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_node_prerequisite(node: &NodePrerequisite) -> Result<()> {
    validate_source_file("Node executable", &node.executable)?;
    if node.executable.file_name() != Some(std::ffi::OsStr::new("node")) {
        return Err(DeployError::LegacyCapture(format!(
            "Node executable must be named `node` to satisfy the legacy bare `node` launch command: {}",
            node.executable.display()
        )));
    }
    let version = node.version.strip_prefix('v').unwrap_or(&node.version);
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(DeployError::LegacyCapture(format!(
            "invalid Node version {:?}",
            node.version
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DependencyFileSnapshot {
    mode: u32,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DependencyTreeSnapshot {
    root_mode: u32,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DependencyClosureSnapshot {
    package_json: DependencyFileSnapshot,
    package_lock: DependencyFileSnapshot,
    node_modules: DependencyTreeSnapshot,
}

impl DependencyClosureSnapshot {
    fn capture(package_json: &Path, package_lock: &Path, node_modules: &Path) -> Result<Self> {
        validate_dependency_closure(
            package_json,
            package_lock,
            node_modules,
            DependencyClosureKind::ExactLive,
        )?;
        Ok(Self {
            package_json: snapshot_dependency_file(package_json)?,
            package_lock: snapshot_dependency_file(package_lock)?,
            node_modules: DependencyTreeSnapshot {
                root_mode: fs::symlink_metadata(node_modules)?.mode() & 0o7777,
                entries: snapshot_tree_entries(node_modules)?,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeDependencySnapshots {
    server: DependencyClosureSnapshot,
}

impl RuntimeDependencySnapshots {
    fn from_sources(sources: &LegacyRuntimeSources) -> Result<Self> {
        validate_sidecar_shared_dependency_contract(
            &sources.claude_sidecar_dir,
            &sources.package_json,
            &sources.production_node_modules,
        )?;
        Ok(Self {
            server: DependencyClosureSnapshot::capture(
                &sources.package_json,
                &sources.package_lock,
                &sources.production_node_modules,
            )?,
        })
    }

    fn from_stage(stage: &Path, bindings: &RuntimeBindings) -> Result<Self> {
        validate_sidecar_shared_dependency_contract(
            &stage.join("claude-sidecar"),
            &stage.join(&bindings.package_json),
            &stage.join(&bindings.production_node_modules),
        )?;
        Ok(Self {
            server: DependencyClosureSnapshot::capture(
                &stage.join(&bindings.package_json),
                &stage.join(&bindings.package_lock),
                &stage.join(&bindings.production_node_modules),
            )?,
        })
    }

    fn verify_captured(
        &self,
        sources: &LegacyRuntimeSources,
        stage: &Path,
        bindings: &RuntimeBindings,
    ) -> Result<()> {
        let current_source = Self::from_sources(sources).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "dependency closure changed during capture: {error}"
            ))
        })?;
        let captured = Self::from_stage(stage, bindings).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "captured dependency closure failed lockfile revalidation: {error}"
            ))
        })?;
        if self != &current_source || self != &captured {
            return Err(DeployError::LegacyCapture(
                "dependency closure changed during capture; refusing to seal mixed runtime bytes"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeTreeSnapshot {
    root_mode: u32,
    entries: Vec<ManifestEntry>,
}

impl RuntimeTreeSnapshot {
    fn capture(root: &Path) -> Result<Self> {
        let before = fs::symlink_metadata(root)?;
        if before.file_type().is_symlink() || !before.is_dir() {
            return Err(DeployError::LegacyCapture(format!(
                "runtime source is not a real directory: {}",
                root.display()
            )));
        }
        let entries = snapshot_tree_entries(root)?;
        let after = fs::symlink_metadata(root)?;
        if after.file_type().is_symlink()
            || !after.is_dir()
            || before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.mode() != after.mode()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
        {
            return Err(DeployError::LegacyCapture(format!(
                "runtime source changed while hashing: {}",
                root.display()
            )));
        }
        Ok(Self {
            root_mode: after.mode() & 0o7777,
            entries,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeSourceSnapshots {
    client: RuntimeTreeSnapshot,
    extensions: RuntimeTreeSnapshot,
    dist_server: RuntimeTreeSnapshot,
    claude_sidecar: RuntimeTreeSnapshot,
    package_json: DependencyFileSnapshot,
    package_lock: DependencyFileSnapshot,
}

impl RuntimeSourceSnapshots {
    fn from_sources(sources: &LegacyRuntimeSources) -> Result<Self> {
        Ok(Self {
            client: RuntimeTreeSnapshot::capture(&sources.client_dir)?,
            extensions: RuntimeTreeSnapshot::capture(&sources.extensions_dir)?,
            dist_server: RuntimeTreeSnapshot::capture(&sources.dist_server_dir)?,
            claude_sidecar: RuntimeTreeSnapshot::capture(&sources.claude_sidecar_dir)?,
            package_json: snapshot_dependency_file(&sources.package_json)?,
            package_lock: snapshot_dependency_file(&sources.package_lock)?,
        })
    }

    fn from_stage(stage: &Path, bindings: &RuntimeBindings) -> Result<Self> {
        Ok(Self {
            client: RuntimeTreeSnapshot::capture(&stage.join(&bindings.client_dir))?,
            extensions: RuntimeTreeSnapshot::capture(&stage.join(&bindings.extensions_dir))?,
            dist_server: RuntimeTreeSnapshot::capture(&stage.join(&bindings.dist_server_dir))?,
            claude_sidecar: RuntimeTreeSnapshot::capture(&stage.join("claude-sidecar"))?,
            package_json: snapshot_dependency_file(&stage.join(&bindings.package_json))?,
            package_lock: snapshot_dependency_file(&stage.join(&bindings.package_lock))?,
        })
    }

    fn verify_captured(
        &self,
        sources: &LegacyRuntimeSources,
        stage: &Path,
        bindings: &RuntimeBindings,
    ) -> Result<()> {
        let current_source = Self::from_sources(sources).map_err(|error| {
            DeployError::LegacyCapture(format!("runtime closure changed during capture: {error}"))
        })?;
        let captured = Self::from_stage(stage, bindings).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "captured runtime closure failed revalidation: {error}"
            ))
        })?;
        if self != &current_source || self != &captured {
            return Err(DeployError::LegacyCapture(
                "runtime closure changed during capture; refusing to seal mixed runtime bytes"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

fn snapshot_dependency_file(path: &Path) -> Result<DependencyFileSnapshot> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(DeployError::LegacyCapture(format!(
            "dependency metadata is not a regular file: {}",
            path.display()
        )));
    }
    let sha256 = sha256_file(path)?;
    let after = fs::symlink_metadata(path)?;
    if after.file_type().is_symlink()
        || !after.is_file()
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mode() != after.mode()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(DeployError::LegacyCapture(format!(
            "dependency metadata changed while hashing: {}",
            path.display()
        )));
    }
    Ok(DependencyFileSnapshot {
        mode: after.mode() & 0o7777,
        sha256,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DependencyClosureKind {
    ExactLive,
    Production,
}

fn validate_dependency_closure(
    package_json: &Path,
    package_lock: &Path,
    node_modules: &Path,
    kind: DependencyClosureKind,
) -> Result<()> {
    let package: Value = serde_json::from_slice(&fs::read(package_json)?).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid package manifest {}: {error}",
            package_json.display()
        ))
    })?;
    if !package.is_object() {
        return Err(DeployError::LegacyCapture(
            "package manifest must be an object".to_string(),
        ));
    }
    let root_lock: Value = serde_json::from_slice(&fs::read(package_lock)?).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid package lockfile {}: {error}",
            package_lock.display()
        ))
    })?;
    let hidden_path = node_modules.join(".package-lock.json");
    let hidden_lock: Value = serde_json::from_slice(&fs::read(&hidden_path).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "production dependency closure has no npm lockfile {}: {error}",
            hidden_path.display()
        ))
    })?)
    .map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid production dependency lockfile {}: {error}",
            hidden_path.display()
        ))
    })?;
    let root_version = root_lock.get("lockfileVersion").and_then(Value::as_u64);
    let hidden_version = hidden_lock.get("lockfileVersion").and_then(Value::as_u64);
    if root_version.is_none() || root_version != hidden_version {
        return Err(DeployError::LegacyCapture(
            "production dependency lockfile version does not match source lockfile".to_string(),
        ));
    }
    let root_packages = packages_object(&root_lock, package_lock)?;
    let hidden_packages = packages_object(&hidden_lock, &hidden_path)?;
    let root_package = root_packages
        .get("")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "source lockfile has no root package entry: {}",
                package_lock.display()
            ))
        })?;
    for field in ["dependencies", "optionalDependencies"] {
        if package.get(field) != root_package.get(field) {
            return Err(DeployError::LegacyCapture(format!(
                "package manifest {field} does not match the source lockfile root entry"
            )));
        }
    }
    let direct_dependencies = package
        .get("dependencies")
        .map(|dependencies| {
            dependencies.as_object().ok_or_else(|| {
                DeployError::LegacyCapture(format!(
                    "package manifest dependencies must be an object: {}",
                    package_json.display()
                ))
            })
        })
        .transpose()?;

    for (path, package) in root_packages {
        if path.is_empty() {
            continue;
        }
        validate_lock_package_path(path)?;
        let package = package.as_object().ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "source lockfile package entry {path} must be an object"
            ))
        })?;
        let required = package.get("dev").and_then(Value::as_bool) != Some(true)
            && package.get("optional").and_then(Value::as_bool) != Some(true);
        if required && !hidden_packages.contains_key(path) {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency closure is missing required lockfile entry {path}"
            )));
        }
    }

    if let Some(direct_dependencies) = direct_dependencies {
        for name in direct_dependencies.keys() {
            let lock_path = format!("node_modules/{name}");
            validate_lock_package_path(&lock_path)?;
            if !hidden_packages.contains_key(&lock_path) {
                return Err(DeployError::LegacyCapture(format!(
                    "production dependency closure is missing direct dependency {name}"
                )));
            }
        }
    }

    for (path, package) in hidden_packages {
        if path.is_empty() {
            continue;
        }
        validate_lock_package_path(path)?;
        let package = package.as_object().ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "production dependency lockfile entry {path} must be an object"
            ))
        })?;
        if kind == DependencyClosureKind::Production
            && package.get("dev").and_then(Value::as_bool) == Some(true)
        {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency lockfile contains dev-only package {path}"
            )));
        }
        let Some(root_package) = root_packages.get(path) else {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency lockfile entry {path} is absent from source lockfile"
            )));
        };
        for field in ["version", "resolved", "integrity", "link"] {
            if package.get(field) != root_package.get(field) {
                return Err(DeployError::LegacyCapture(format!(
                    "production dependency lockfile entry {path} has mismatched {field}"
                )));
            }
        }
        let relative = Path::new(path)
            .strip_prefix("node_modules")
            .expect("validated lock package path");
        let physical = node_modules.join(relative);
        let metadata = fs::symlink_metadata(&physical).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "production dependency closure has no physical package for {path} at {}: {error}",
                physical.display()
            ))
        })?;
        if !(metadata.is_dir() || metadata.file_type().is_symlink()) {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency closure physical package for {path} is not a directory or symlink: {}",
                physical.display()
            )));
        }
        validate_physical_package_metadata(path, package, &physical, node_modules)?;
    }
    let hidden_paths: BTreeSet<String> = hidden_packages
        .keys()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect();
    let physical_paths = installed_package_paths(node_modules)?;
    if physical_paths != hidden_paths {
        let unlisted: Vec<_> = physical_paths.difference(&hidden_paths).cloned().collect();
        let missing: Vec<_> = hidden_paths.difference(&physical_paths).cloned().collect();
        return Err(DeployError::LegacyCapture(format!(
            "production dependency closure physical package set does not match lockfile; unlisted={unlisted:?}, missing={missing:?}"
        )));
    }
    Ok(())
}

fn validate_sidecar_shared_dependency_contract(
    sidecar_root: &Path,
    shared_package_json: &Path,
    shared_node_modules: &Path,
) -> Result<()> {
    let nested = sidecar_root.join("node_modules");
    match fs::symlink_metadata(&nested) {
        Ok(_) => {
            return Err(DeployError::LegacyCapture(format!(
                "Claude sidecar must use the single root production dependency closure, not {}",
                nested.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    validate_dependency_subset(
        &sidecar_root.join("package.json"),
        &sidecar_root.join("package-lock.json"),
        shared_package_json,
        shared_node_modules,
    )
}

fn validate_dependency_subset(
    package_json: &Path,
    package_lock: &Path,
    shared_package_json: &Path,
    shared_node_modules: &Path,
) -> Result<()> {
    let package: Value = serde_json::from_slice(&fs::read(package_json)?).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid sidecar package manifest {}: {error}",
            package_json.display()
        ))
    })?;
    let lock: Value = serde_json::from_slice(&fs::read(package_lock)?).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid sidecar package lockfile {}: {error}",
            package_lock.display()
        ))
    })?;
    let shared_package: Value =
        serde_json::from_slice(&fs::read(shared_package_json)?).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "invalid shared package manifest {}: {error}",
                shared_package_json.display()
            ))
        })?;
    let hidden_path = shared_node_modules.join(".package-lock.json");
    let hidden_lock: Value = serde_json::from_slice(&fs::read(&hidden_path)?).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "invalid shared production dependency lockfile {}: {error}",
            hidden_path.display()
        ))
    })?;
    if lock
        .get("lockfileVersion")
        .and_then(Value::as_u64)
        .is_none()
        || lock.get("lockfileVersion").and_then(Value::as_u64)
            != hidden_lock.get("lockfileVersion").and_then(Value::as_u64)
    {
        return Err(DeployError::LegacyCapture(
            "sidecar lockfile version does not match the shared production closure".to_string(),
        ));
    }
    let lock_packages = packages_object(&lock, package_lock)?;
    let shared_packages = packages_object(&hidden_lock, &hidden_path)?;
    let root_package = lock_packages
        .get("")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "sidecar lockfile has no root package entry: {}",
                package_lock.display()
            ))
        })?;
    for field in ["dependencies", "optionalDependencies"] {
        if package.get(field) != root_package.get(field) {
            return Err(DeployError::LegacyCapture(format!(
                "sidecar package manifest {field} does not match its lockfile root entry"
            )));
        }
    }
    for (path, package) in lock_packages {
        if path.is_empty() {
            continue;
        }
        validate_lock_package_path(path)?;
        if !package.is_object() {
            return Err(DeployError::LegacyCapture(format!(
                "sidecar lockfile package entry {path} must be an object"
            )));
        }
    }
    for field in ["dependencies", "optionalDependencies"] {
        let direct_dependencies = package
            .get(field)
            .map(|dependencies| {
                dependencies.as_object().ok_or_else(|| {
                    DeployError::LegacyCapture(format!(
                        "sidecar package manifest {field} must be an object"
                    ))
                })
            })
            .transpose()?;
        let Some(direct_dependencies) = direct_dependencies else {
            continue;
        };
        let shared_declarations = shared_package
            .get(field)
            .and_then(Value::as_object)
            .ok_or_else(|| {
                DeployError::LegacyCapture(format!(
                    "shared root package has no {field} declarations required by the sidecar"
                ))
            })?;
        for (name, specification) in direct_dependencies {
            if shared_declarations.get(name) != Some(specification) {
                return Err(DeployError::LegacyCapture(format!(
                    "shared root package direct dependency specification does not match sidecar {name}"
                )));
            }
            if field == "optionalDependencies" {
                continue;
            }
            let lock_path = format!("node_modules/{name}");
            validate_lock_package_path(&lock_path)?;
            let sidecar_locked = lock_packages
                .get(&lock_path)
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    DeployError::LegacyCapture(format!(
                        "sidecar lockfile is missing direct dependency {name}"
                    ))
                })?;
            let shared = shared_packages
                .get(&lock_path)
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    DeployError::LegacyCapture(format!(
                        "shared production dependency closure is missing sidecar dependency {name}"
                    ))
                })?;
            for metadata_field in ["version", "link"] {
                if sidecar_locked.get(metadata_field) != shared.get(metadata_field) {
                    return Err(DeployError::LegacyCapture(format!(
                        "shared production dependency closure has mismatched sidecar direct {metadata_field} for {lock_path}"
                    )));
                }
            }
            let relative = Path::new(&lock_path)
                .strip_prefix("node_modules")
                .expect("validated sidecar lock package path");
            validate_physical_package_metadata(
                &lock_path,
                shared,
                &shared_node_modules.join(relative),
                shared_node_modules,
            )?;
        }
    }
    Ok(())
}

fn validate_physical_package_metadata(
    lock_path: &str,
    lock_package: &serde_json::Map<String, Value>,
    physical: &Path,
    node_modules: &Path,
) -> Result<()> {
    let physical_metadata = fs::symlink_metadata(physical)?;
    let physical_is_link = physical_metadata.file_type().is_symlink();
    let lock_is_link = match lock_package.get("link") {
        Some(value) => value.as_bool().ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "production dependency lockfile link flag is not a boolean for {lock_path}"
            ))
        })?,
        None => false,
    };
    if physical_is_link != lock_is_link {
        return Err(DeployError::LegacyCapture(format!(
            "production dependency physical package link semantics do not match {lock_path}"
        )));
    }
    if physical_is_link {
        let target = fs::read_link(physical)?;
        validate_symlink_target(Path::new(lock_path), &target).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "production dependency physical package has an unsafe symlink for {lock_path}: {error}"
            ))
        })?;
        let canonical_modules = fs::canonicalize(node_modules)?;
        let target_path = physical
            .parent()
            .expect("physical npm package has a parent")
            .join(&target);
        let canonical_target = fs::canonicalize(&target_path).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "production dependency physical package link target is unavailable for {lock_path}: {error}"
            ))
        })?;
        if !canonical_target.starts_with(&canonical_modules) {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency physical package link target escapes the captured node_modules tree for {lock_path}"
            )));
        }
    }
    let package_path = physical.join("package.json");
    let package: Value = serde_json::from_slice(&fs::read(&package_path).map_err(|error| {
        DeployError::LegacyCapture(format!(
            "production dependency physical package metadata is unavailable for {lock_path} at {}: {error}",
            package_path.display()
        ))
    })?)
    .map_err(|error| {
        DeployError::LegacyCapture(format!(
            "production dependency physical package metadata is invalid for {lock_path}: {error}"
        ))
    })?;
    let expected_name = package_name_from_lock_path(lock_path)?;
    if package.get("name").and_then(Value::as_str) != Some(expected_name.as_str()) {
        return Err(DeployError::LegacyCapture(format!(
            "production dependency physical package metadata name does not match {lock_path}"
        )));
    }
    if let Some(expected_version) = lock_package.get("version") {
        let expected_version = expected_version.as_str().ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "production dependency lockfile version is not a string for {lock_path}"
            ))
        })?;
        if package.get("version").and_then(Value::as_str) != Some(expected_version) {
            return Err(DeployError::LegacyCapture(format!(
                "production dependency physical package metadata version does not match {lock_path}"
            )));
        }
    }
    Ok(())
}

fn package_name_from_lock_path(lock_path: &str) -> Result<String> {
    let components: Vec<&str> = lock_path.split('/').collect();
    let node_modules = components
        .iter()
        .rposition(|component| *component == "node_modules")
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "npm lockfile package path has no node_modules component: {lock_path}"
            ))
        })?;
    let package = &components[node_modules + 1..];
    match package {
        [name, ..] if !name.starts_with('@') => Ok((*name).to_string()),
        [scope, name, ..] if scope.starts_with('@') => Ok(format!("{scope}/{name}")),
        _ => Err(DeployError::LegacyCapture(format!(
            "npm lockfile package path has no package name: {lock_path}"
        ))),
    }
}

fn installed_package_paths(node_modules: &Path) -> Result<BTreeSet<String>> {
    let mut packages = BTreeSet::new();
    collect_installed_packages(node_modules, Path::new("node_modules"), &mut packages)?;
    Ok(packages)
}

fn collect_installed_packages(
    directory: &Path,
    lock_prefix: &Path,
    packages: &mut BTreeSet<String>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_str().ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "production node_modules entry is not UTF-8: {}",
                entry.path().display()
            ))
        })?;
        if matches!(name, ".package-lock.json" | ".bin") {
            continue;
        }
        if name.starts_with('@') {
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(DeployError::LegacyCapture(format!(
                    "production dependency scope is not a real directory: {}",
                    entry.path().display()
                )));
            }
            let mut scoped = fs::read_dir(entry.path())?.collect::<std::io::Result<Vec<_>>>()?;
            scoped.sort_by_key(|child| child.file_name());
            for child in scoped {
                register_installed_package(
                    &child.path(),
                    &lock_prefix.join(name).join(child.file_name()),
                    packages,
                )?;
            }
        } else {
            register_installed_package(&entry.path(), &lock_prefix.join(name), packages)?;
        }
    }
    Ok(())
}

fn register_installed_package(
    package_path: &Path,
    lock_path: &Path,
    packages: &mut BTreeSet<String>,
) -> Result<()> {
    validate_relative_path(lock_path, false).map_err(|error| {
        DeployError::LegacyCapture(format!("unsafe installed package path: {error}"))
    })?;
    let metadata = fs::symlink_metadata(package_path)?;
    if !(metadata.is_dir() || metadata.file_type().is_symlink()) {
        return Err(DeployError::LegacyCapture(format!(
            "production dependency physical package is not a directory or symlink: {}",
            package_path.display()
        )));
    }
    let lock_path = lock_path
        .to_str()
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "installed package lock path is not UTF-8: {}",
                lock_path.display()
            ))
        })?
        .to_string();
    packages.insert(lock_path.clone());
    if metadata.is_dir() {
        let nested = package_path.join("node_modules");
        match fs::symlink_metadata(&nested) {
            Ok(nested_metadata)
                if nested_metadata.is_dir() && !nested_metadata.file_type().is_symlink() =>
            {
                collect_installed_packages(
                    &nested,
                    &Path::new(&lock_path).join("node_modules"),
                    packages,
                )?;
            }
            Ok(_) => {
                return Err(DeployError::LegacyCapture(format!(
                    "nested node_modules is not a real directory: {}",
                    nested.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn validate_lock_package_path(path: &str) -> Result<()> {
    let path = Path::new(path);
    validate_relative_path(path, false).map_err(|error| {
        DeployError::LegacyCapture(format!("unsafe npm lockfile package path: {error}"))
    })?;
    let mut components = path.components();
    if components.next().map(|part| part.as_os_str()) != Some("node_modules".as_ref())
        || components.next().is_none()
    {
        return Err(DeployError::LegacyCapture(format!(
            "npm lockfile package path is outside node_modules: {}",
            path.display()
        )));
    }
    Ok(())
}

fn packages_object<'a>(lock: &'a Value, path: &Path) -> Result<&'a serde_json::Map<String, Value>> {
    lock.get("packages")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "npm lockfile has no packages object: {}",
                path.display()
            ))
        })
}

fn source_mode(path: &Path) -> Result<u32> {
    Ok(fs::metadata(path)?.mode() & 0o7777)
}

struct ScratchWorkspace {
    root: PathBuf,
    isolated_home: PathBuf,
    parent: PathBuf,
    active: bool,
}

impl ScratchWorkspace {
    fn create(parent: &Path) -> Result<Self> {
        let root = parent.join(format!(".scratch-{}", Uuid::new_v4()));
        fs::create_dir(&root)?;
        let isolated_home = root.join("home");
        let workspace = Self {
            root,
            isolated_home,
            parent: parent.to_path_buf(),
            active: true,
        };
        fs::set_permissions(&workspace.root, fs::Permissions::from_mode(0o700))?;
        fs::create_dir(&workspace.isolated_home)?;
        fs::set_permissions(&workspace.isolated_home, fs::Permissions::from_mode(0o700))?;
        sync_directory(&workspace.isolated_home)?;
        sync_directory(&workspace.root)?;
        sync_directory(&workspace.parent)?;
        Ok(workspace)
    }

    fn isolated_home(&self) -> &Path {
        &self.isolated_home
    }

    fn cleanup(mut self) -> Result<()> {
        fs::remove_dir_all(&self.root)?;
        self.active = false;
        sync_directory(&self.parent)
    }
}

impl Drop for ScratchWorkspace {
    fn drop(&mut self) {
        if self.active && fs::remove_dir_all(&self.root).is_ok() {
            self.active = false;
            let _ = sync_directory(&self.parent);
        }
    }
}

fn combine_scratch_results(probe: Result<()>, cleanup: Result<()>) -> Result<()> {
    match (probe, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Err(probe_error), Err(cleanup_error)) => Err(DeployError::LegacyCapture(format!(
            "scratch validation failed: {probe_error}; scratch cleanup also failed: {cleanup_error}"
        ))),
    }
}

pub struct RealScratchProbe {
    timeout: Duration,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScratchReadyReceipt {
    schema_version: String,
    nonce: String,
    actual_address: String,
    pid: u32,
    boot_id: String,
    instance_id: String,
    server_process_generation_id: String,
    server_component_version: String,
    build_commit: String,
}

trait ChildLifecycle {
    fn terminate(&mut self) -> std::io::Result<()>;
    fn reap(&mut self, timeout: Duration) -> std::io::Result<()>;
}

impl ChildLifecycle for std::process::Child {
    fn terminate(&mut self) -> std::io::Result<()> {
        if self.try_wait()?.is_none() {
            self.kill()?;
        }
        Ok(())
    }

    fn reap(&mut self, timeout: Duration) -> std::io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.try_wait()?.is_some() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "child did not exit before cleanup deadline",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);

struct ChildGuard<Child: ChildLifecycle> {
    child: Option<Child>,
}

impl<Child: ChildLifecycle> ChildGuard<Child> {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn finish(mut self, label: &str) -> Result<()> {
        let terminate_error = self
            .child
            .as_mut()
            .expect("guard has a child")
            .terminate()
            .err();
        let reap_error = self
            .child
            .as_mut()
            .expect("guard has a child")
            .reap(CHILD_REAP_TIMEOUT)
            .err();
        match (terminate_error, reap_error) {
            (None, None) => {
                self.child.take();
                Ok(())
            }
            (terminate_error, reap_error) => Err(DeployError::LegacyCapture(format!(
                "{label} cleanup failed: terminate={}; reap={}",
                terminate_error
                    .as_ref()
                    .map_or_else(|| "ok".to_string(), ToString::to_string),
                reap_error
                    .as_ref()
                    .map_or_else(|| "ok".to_string(), ToString::to_string)
            ))),
        }
    }
}

fn validate_and_finish<Child, T>(
    mut guard: ChildGuard<Child>,
    label: &str,
    validate: impl FnOnce(&mut ChildGuard<Child>) -> Result<T>,
) -> Result<T>
where
    Child: ChildLifecycle,
{
    let validation = validate(&mut guard);
    let cleanup = guard.finish(label);
    match (validation, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(validation_error), Err(cleanup_error)) => Err(DeployError::LegacyCapture(format!(
            "{label} validation failed: {validation_error}; cleanup also failed: {cleanup_error}"
        ))),
    }
}

impl<Child: ChildLifecycle> Deref for ChildGuard<Child> {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        self.child.as_ref().expect("guard has a child")
    }
}

impl<Child: ChildLifecycle> DerefMut for ChildGuard<Child> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.child.as_mut().expect("guard has a child")
    }
}

impl<Child: ChildLifecycle> Drop for ChildGuard<Child> {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.terminate();
            let _ = child.reap(CHILD_REAP_TIMEOUT);
        }
    }
}

impl Default for RealScratchProbe {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
        }
    }
}

impl ScratchProbe for RealScratchProbe {
    fn verify(&self, request: &ScratchProbeRequest) -> Result<()> {
        let version_child = Command::new(&request.node.executable)
            .arg("--version")
            .env_clear()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                DeployError::LegacyCapture(format!("cannot execute captured Node: {error}"))
            })?;
        validate_and_finish(
            ChildGuard::new(version_child),
            "Node version probe",
            |version_child| {
                wait_for_success(version_child, self.timeout, "Node version probe")?;
                let mut version = String::new();
                version_child
                    .stdout
                    .as_mut()
                    .ok_or_else(|| {
                        DeployError::LegacyCapture("Node stdout unavailable".to_string())
                    })?
                    .read_to_string(&mut version)?;
                if version.trim() != request.node.version {
                    return Err(DeployError::LegacyCapture(
                        "captured Node executable/version prerequisite changed".to_string(),
                    ));
                }
                Ok(())
            },
        )?;

        let node_parent = request
            .node
            .executable
            .parent()
            .expect("validated absolute Node executable has a parent");
        let bare_node = fs::canonicalize(node_parent.join("node"))?;
        if bare_node != request.node.executable {
            return Err(DeployError::LegacyCapture(
                "legacy bare `node` does not resolve to the verified Node prerequisite".to_string(),
            ));
        }
        let bare_child = Command::new("node")
            .arg("--version")
            .env_clear()
            .env("PATH", node_parent)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                DeployError::LegacyCapture(format!(
                    "legacy bare `node` prerequisite could not execute: {error}"
                ))
            })?;
        validate_and_finish(
            ChildGuard::new(bare_child),
            "legacy bare Node probe",
            |bare_child| {
                wait_for_success(bare_child, self.timeout, "legacy bare Node probe")?;
                let mut bare_version = String::new();
                bare_child
                    .stdout
                    .as_mut()
                    .ok_or_else(|| {
                        DeployError::LegacyCapture("bare Node stdout unavailable".to_string())
                    })?
                    .read_to_string(&mut bare_version)?;
                if bare_version.trim() != request.node.version {
                    return Err(DeployError::LegacyCapture(
                        "legacy bare `node` version differs from the verified prerequisite"
                            .to_string(),
                    ));
                }
                Ok(())
            },
        )?;

        verify_sidecar_import(request, self.timeout)?;
        verify_mcp_import(request, self.timeout)?;
        verify_scratch_server(request, self.timeout)
    }
}

fn verify_sidecar_import(request: &ScratchProbeRequest, timeout: Duration) -> Result<()> {
    let child = Command::new(&request.node.executable)
        .arg(request.claude_sidecar_entry())
        .current_dir(&request.generation_path)
        .env_clear()
        .env("HOME", &request.isolated_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| DeployError::LegacyCapture(format!("sidecar import failed: {error}")))?;
    validate_and_finish(ChildGuard::new(child), "Claude sidecar import", |child| {
        child
            .stdin
            .as_mut()
            .ok_or_else(|| DeployError::LegacyCapture("sidecar stdin unavailable".to_string()))?
            .write_all(b"{\"type\":\"shutdown\"}\n")?;
        drop(child.stdin.take());
        wait_for_success(child, timeout, "Claude sidecar import")
    })
}

fn verify_mcp_import(request: &ScratchProbeRequest, timeout: Duration) -> Result<()> {
    let script = "const {pathToFileURL}=await import('node:url');\
                  await import(pathToFileURL(process.argv[1]).href);process.exit(0)";
    let child = Command::new(&request.node.executable)
        .args(["--input-type=module", "--eval", script])
        .arg(request.mcp_entry())
        .current_dir(&request.generation_path)
        .env_clear()
        .env("HOME", &request.isolated_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| DeployError::LegacyCapture(format!("MCP import failed: {error}")))?;
    validate_and_finish(ChildGuard::new(child), "MCP import", |child| {
        wait_for_success(child, timeout, "MCP import")
    })?;

    let fallback_script = "const {readFile}=await import('node:fs/promises');\
         const {resolve}=await import('node:path');\
         const {pathToFileURL}=await import('node:url');\
         JSON.parse(await readFile(resolve('package.json'),'utf8'));\
         await import(pathToFileURL(resolve('dist/server/mcp/server.js')).href);process.exit(0)";
    let child = Command::new(&request.node.executable)
        .args(["--input-type=module", "--eval", fallback_script])
        .current_dir(&request.generation_path)
        .env_clear()
        .env("HOME", &request.isolated_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            DeployError::LegacyCapture(format!(
                "pre-binding legacy MCP fallback import failed: {error}"
            ))
        })?;
    validate_and_finish(
        ChildGuard::new(child),
        "pre-binding legacy MCP fallback import",
        |child| wait_for_success(child, timeout, "pre-binding legacy MCP fallback import"),
    )
}

fn verify_scratch_server(request: &ScratchProbeRequest, timeout: Duration) -> Result<()> {
    let log_path = request.isolated_home.join("scratch-server.log");
    let log = File::create(&log_path)?;
    let stderr = log.try_clone()?;
    let ready_path = request.isolated_home.join("ready.json");
    let nonce = Uuid::new_v4().to_string();
    let auth_token = format!("scratch-{}", Uuid::new_v4());
    let mut command = Command::new(request.server_executable());
    command
        .current_dir(&request.generation_path)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    for (name, value) in scratch_server_environment(request, &ready_path, &nonce, &auth_token) {
        command.env(name, value);
    }
    let child = command.spawn().map_err(|error| {
        DeployError::LegacyCapture(format!("scratch server could not start: {error}"))
    })?;
    let child_pid = child.id();
    validate_and_finish(ChildGuard::new(child), "scratch server", |child| {
        let deadline = Instant::now() + timeout;
        let mut address = None;
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                return Err(DeployError::LegacyCapture(format!(
                    "scratch server exited before readiness: {status}; {}",
                    read_bounded_log(&log_path)
                )));
            }
            match fs::read(&ready_path) {
                Ok(raw) => {
                    address = Some(validate_scratch_ready_receipt(
                        &raw,
                        &nonce,
                        &request.generation_id,
                        child_pid,
                    )?);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if address.is_none() {
                address = parse_listening_address(&read_bounded_log(&log_path));
            }
            if address.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let address = address.ok_or_else(|| {
            DeployError::LegacyCapture(format!(
                "scratch server did not become ready; {}",
                read_bounded_log(&log_path)
            ))
        })?;
        let port = validate_scratch_loopback_address(address)?;
        validate_scratch_listener(port, child_pid)?;
        scratch_health(port, &auth_token)?;
        scratch_client(port, request)?;
        scratch_extensions(port, request, &auth_token)?;
        validate_scratch_listener(port, child_pid)
    })
}

fn scratch_server_environment(
    request: &ScratchProbeRequest,
    ready_path: &Path,
    nonce: &str,
    auth_token: &str,
) -> Vec<(&'static str, OsString)> {
    vec![
        ("AUTH_TOKEN", auth_token.into()),
        ("PORT", "0".into()),
        ("FRESHELL_BIND_HOST", "127.0.0.1".into()),
        (
            "PATH",
            request
                .node
                .executable
                .parent()
                .expect("validated Node executable has a parent")
                .as_os_str()
                .to_owned(),
        ),
        ("HOME", request.isolated_home.as_os_str().to_owned()),
        (
            "FRESHELL_HOME",
            request.isolated_home.as_os_str().to_owned(),
        ),
        ("NODE_ENV", "production".into()),
        ("FRESHELL_CLIENT_DIR", request.client_dir().into_os_string()),
        (
            "FRESHELL_EXTENSIONS_DIR",
            request.extensions_dir().into_os_string(),
        ),
        (
            "FRESHELL_CLAUDE_SIDECAR",
            request.claude_sidecar_entry().into_os_string(),
        ),
        (
            "FRESHELL_CLAUDE_NODE",
            request.node.executable.as_os_str().to_owned(),
        ),
        (
            "FRESHELL_MCP_SERVER_ENTRY",
            request.mcp_entry().into_os_string(),
        ),
        (
            "FRESHELL_DEPLOY_READY_FILE",
            ready_path.as_os_str().to_owned(),
        ),
        ("FRESHELL_DEPLOY_NONCE", nonce.into()),
        (
            "FRESHELL_DEPLOY_GENERATION_ID",
            request.generation_id.as_str().into(),
        ),
    ]
}

fn validate_scratch_ready_receipt(
    raw: &[u8],
    nonce: &str,
    generation_id: &str,
    child_pid: u32,
) -> Result<SocketAddr> {
    let receipt: ScratchReadyReceipt = serde_json::from_slice(raw).map_err(|error| {
        DeployError::LegacyCapture(format!("scratch ready receipt is invalid: {error}"))
    })?;
    let address: SocketAddr = receipt.actual_address.parse().map_err(|error| {
        DeployError::LegacyCapture(format!(
            "scratch ready receipt has invalid actualAddress: {error}"
        ))
    })?;
    if receipt.schema_version != "1"
        || receipt.nonce != nonce
        || receipt.server_process_generation_id != generation_id
        || receipt.pid != child_pid
        || receipt.boot_id.is_empty()
        || receipt.instance_id.is_empty()
        || receipt.server_component_version.is_empty()
        || receipt.build_commit.is_empty()
    {
        return Err(DeployError::LegacyCapture(
            "scratch ready receipt does not identify the isolated candidate".to_string(),
        ));
    }
    validate_scratch_loopback_address(address)?;
    Ok(address)
}

fn validate_scratch_listener(port: DeployPort, child_pid: u32) -> Result<()> {
    let listener = LinuxProcfs::default().resolve_listener_for_pid(port, child_pid)?;
    if listener.owner_pid != child_pid {
        return Err(DeployError::LegacyCapture(format!(
            "scratch listener on port {port} belongs to pid {}, not spawned pid {child_pid}",
            listener.owner_pid
        )));
    }
    Ok(())
}

fn wait_for_success(
    child: &mut ChildGuard<std::process::Child>,
    timeout: Duration,
    label: &str,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut stderr = String::new();
            if let Some(pipe) = child.stderr.as_mut() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            return Err(DeployError::LegacyCapture(format!(
                "{label} failed with {status}: {}",
                truncate(&stderr, 4096)
            )));
        }
        if Instant::now() >= deadline {
            return Err(DeployError::LegacyCapture(format!("{label} timed out")));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn scratch_health(port: DeployPort, auth_token: &str) -> Result<()> {
    let response = scratch_get(port, "/api/health", Some(auth_token))?;
    let health: Value = serde_json::from_slice(&response).map_err(|error| {
        DeployError::LegacyCapture(format!("scratch health response is invalid: {error}"))
    })?;
    if health.get("app").and_then(Value::as_str) != Some("freshell")
        || health.get("ok").and_then(Value::as_bool) != Some(true)
        || health.get("ready").and_then(Value::as_bool) != Some(true)
    {
        return Err(DeployError::LegacyCapture(
            "scratch health response does not report a ready Freshell server".to_string(),
        ));
    }
    Ok(())
}

fn scratch_client(port: DeployPort, request: &ScratchProbeRequest) -> Result<()> {
    let expected = fs::read(request.client_dir().join("index.html"))?;
    let actual = scratch_get(port, "/", None)?;
    if actual != expected {
        return Err(DeployError::LegacyCapture(
            "scratch server did not serve the captured client entry".to_string(),
        ));
    }
    Ok(())
}

fn scratch_extensions(
    port: DeployPort,
    request: &ScratchProbeRequest,
    auth_token: &str,
) -> Result<()> {
    let expected = expected_extension_names(&request.extensions_dir())?;
    let raw = scratch_get(port, "/api/extensions", Some(auth_token))?;
    let registry: Vec<Value> = serde_json::from_slice(&raw).map_err(|error| {
        DeployError::LegacyCapture(format!("scratch extension registry is invalid: {error}"))
    })?;
    let actual: BTreeSet<String> = registry
        .iter()
        .map(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    DeployError::LegacyCapture(
                        "scratch extension registry contains an unnamed entry".to_string(),
                    )
                })
        })
        .collect::<Result<_>>()?;
    if actual != expected {
        return Err(DeployError::LegacyCapture(format!(
            "scratch extension registry does not match captured extensions: expected {expected:?}, got {actual:?}"
        )));
    }
    Ok(())
}

fn expected_extension_names(directory: &Path) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = entry.file_type()?;
        if !(metadata.is_dir() || metadata.is_symlink()) {
            continue;
        }
        let manifest_path = entry.path().join("freshell.json");
        let raw = match fs::read(&manifest_path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let manifest: Value = serde_json::from_slice(&raw).map_err(|error| {
            DeployError::LegacyCapture(format!(
                "captured extension manifest {} is invalid: {error}",
                manifest_path.display()
            ))
        })?;
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                DeployError::LegacyCapture(format!(
                    "captured extension manifest {} has no name",
                    manifest_path.display()
                ))
            })?;
        if !names.insert(name.to_string()) {
            return Err(DeployError::LegacyCapture(format!(
                "captured extensions contain duplicate name {name}"
            )));
        }
    }
    if names.is_empty() {
        return Err(DeployError::LegacyCapture(format!(
            "captured extensions directory has no freshell.json manifests: {}",
            directory.display()
        )));
    }
    Ok(names)
}

fn scratch_get(port: DeployPort, path: &str, auth_token: Option<&str>) -> Result<Vec<u8>> {
    let response = bounded_http_get(
        SocketAddr::from(([127, 0, 0, 1], port.get())),
        "localhost",
        path,
        auth_token,
        HttpLimits::default(),
    )
    .map_err(|error| DeployError::LegacyCapture(format!("scratch HTTP request failed: {error}")))?;
    if response.status != 200 {
        return Err(DeployError::LegacyCapture(format!(
            "scratch HTTP check for {path} returned {}",
            response.status
        )));
    }
    Ok(response.body)
}

fn parse_listening_address(log: &str) -> Option<SocketAddr> {
    let marker = "listening on http://";
    let after = log.rsplit_once(marker)?.1;
    after
        .split_whitespace()
        .next()?
        .trim_end_matches('/')
        .parse()
        .ok()
}

fn validate_scratch_loopback_address(address: SocketAddr) -> Result<DeployPort> {
    if !address.ip().is_loopback() {
        return Err(DeployError::LegacyCapture(format!(
            "scratch server bound non-loopback address {address}"
        )));
    }
    DeployPort::new(address.port())
}

fn read_bounded_log(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|raw| truncate(&raw, 8192))
        .unwrap_or_default()
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    struct FakeChildLifecycle {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl ChildLifecycle for FakeChildLifecycle {
        fn terminate(&mut self) -> std::io::Result<()> {
            self.events.lock().unwrap().push("terminate");
            Ok(())
        }

        fn reap(&mut self, _timeout: Duration) -> std::io::Result<()> {
            self.events.lock().unwrap().push("reap");
            Ok(())
        }
    }

    #[test]
    fn scratch_child_guard_terminates_and_reaps_on_early_return() {
        let events = Arc::new(Mutex::new(Vec::new()));
        {
            let _guard = ChildGuard::new(FakeChildLifecycle {
                events: Arc::clone(&events),
            });
        }
        assert_eq!(*events.lock().unwrap(), vec!["terminate", "reap"]);
    }

    #[test]
    fn successful_scratch_child_cleanup_is_explicit_and_checked() {
        let events = Arc::new(Mutex::new(Vec::new()));
        ChildGuard::new(FakeChildLifecycle {
            events: Arc::clone(&events),
        })
        .finish("fake child")
        .unwrap();

        assert_eq!(*events.lock().unwrap(), vec!["terminate", "reap"]);
    }

    struct FailingChildLifecycle {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl ChildLifecycle for FailingChildLifecycle {
        fn terminate(&mut self) -> std::io::Result<()> {
            self.events.lock().unwrap().push("terminate");
            Err(std::io::Error::other("terminate failure"))
        }

        fn reap(&mut self, _timeout: Duration) -> std::io::Result<()> {
            self.events.lock().unwrap().push("reap");
            Err(std::io::Error::other("reap failure"))
        }
    }

    #[test]
    fn failed_explicit_cleanup_attempts_both_steps_and_keeps_drop_fallback_armed() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let error = ChildGuard::new(FailingChildLifecycle {
            events: Arc::clone(&events),
        })
        .finish("fake child")
        .unwrap_err();

        assert!(error.to_string().contains("terminate failure"));
        assert!(error.to_string().contains("reap failure"));
        assert_eq!(
            *events.lock().unwrap(),
            vec!["terminate", "reap", "terminate", "reap"]
        );
    }

    #[test]
    fn validation_and_cleanup_errors_are_combined_after_checked_cleanup() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let error = validate_and_finish(
            ChildGuard::new(FailingChildLifecycle {
                events: Arc::clone(&events),
            }),
            "fake child",
            |_| Err::<(), _>(DeployError::LegacyCapture("validation failure".to_string())),
        )
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("validation failure"));
        assert!(message.contains("terminate failure"));
        assert!(message.contains("reap failure"));
        assert_eq!(
            *events.lock().unwrap(),
            vec!["terminate", "reap", "terminate", "reap"]
        );
    }

    #[test]
    fn scratch_server_environment_forces_loopback_with_the_production_key() {
        let request = ScratchProbeRequest {
            generation_path: PathBuf::from("/generation"),
            generation_id: "a".repeat(64),
            isolated_home: PathBuf::from("/scratch/home"),
            port: 0,
            runtime: RuntimeBindings {
                server_executable: "server/freshell-server".to_string(),
                client_dir: "client".to_string(),
                extensions_dir: "extensions".to_string(),
                dist_server_dir: "dist/server".to_string(),
                mcp_entry: "dist/server/mcp/server.js".to_string(),
                claude_sidecar_entry: "claude-sidecar/index.mjs".to_string(),
                package_json: "package.json".to_string(),
                package_lock: "package-lock.json".to_string(),
                production_node_modules: "node_modules".to_string(),
            },
            node: NodePrerequisite {
                executable: PathBuf::from("/runtime/node"),
                version: "v22.18.0".to_string(),
            },
        };
        let environment: std::collections::BTreeMap<_, _> = scratch_server_environment(
            &request,
            Path::new("/scratch/ready.json"),
            "nonce",
            "token",
        )
        .into_iter()
        .collect();

        assert_eq!(
            environment.get("FRESHELL_BIND_HOST"),
            Some(&OsString::from("127.0.0.1"))
        );
        assert_eq!(
            environment.get("FRESHELL_HOME"),
            Some(&OsString::from("/scratch/home"))
        );
        assert_eq!(
            environment.get("HOME"),
            Some(&OsString::from("/scratch/home"))
        );
        assert_eq!(environment.get("PATH"), Some(&OsString::from("/runtime")));
        assert!(!environment.contains_key("BIND_HOST"));
        assert_eq!(
            environment.get("FRESHELL_DEPLOY_GENERATION_ID"),
            Some(&OsString::from("a".repeat(64)))
        );
    }

    #[test]
    fn scratch_ready_receipt_is_nonce_generation_pid_and_loopback_bound() {
        let raw = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": "1",
            "nonce": "nonce",
            "actualAddress": "127.0.0.1:45678",
            "pid": 42,
            "bootId": "boot-id",
            "instanceId": "instance-id",
            "serverProcessGenerationId": "generation",
            "serverComponentVersion": "0.7.0",
            "buildCommit": "abc123"
        }))
        .unwrap();
        assert_eq!(
            validate_scratch_ready_receipt(&raw, "nonce", "generation", 42).unwrap(),
            "127.0.0.1:45678".parse::<SocketAddr>().unwrap()
        );
        assert!(validate_scratch_ready_receipt(&raw, "different", "generation", 42).is_err());
    }

    #[test]
    fn legacy_log_readiness_must_name_the_loopback_address() {
        let loopback =
            parse_listening_address("freshell-server listening on http://127.0.0.1:45678")
                .expect("loopback address");
        assert_eq!(
            validate_scratch_loopback_address(loopback).unwrap(),
            DeployPort::new(45_678).unwrap()
        );

        let wildcard = parse_listening_address("freshell-server listening on http://0.0.0.0:45678")
            .expect("wildcard address");
        assert!(matches!(
            validate_scratch_loopback_address(wildcard),
            Err(DeployError::LegacyCapture(message)) if message.contains("loopback")
        ));
    }
}
