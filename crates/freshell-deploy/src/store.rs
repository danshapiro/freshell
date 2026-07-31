use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::durable::{
    atomic_symlink, atomic_write, atomic_write_new, rename_noreplace, sync_directory,
};
use crate::error::{DeployError, Result};
use crate::journal::{DurableTransactionJournal, TransactionJournal};
use crate::legacy::LegacyCaptureReceipt;
use crate::locks::DeploymentLock;
use crate::manifest::{copy_open_file, copy_regular_file, GenerationManifest, MANIFEST_FILE_NAME};
use crate::paths::{validate_relative_path, validate_symlink_target, DeployPort, StorePaths};
use crate::receipts::{validate_generation_id, LiveReceipt};

pub const DEFAULT_RETAINED_UNPROTECTED_GENERATIONS: usize = 2;

#[derive(Debug, Clone)]
pub struct Generation {
    pub id: String,
    pub path: PathBuf,
    pub manifest: GenerationManifest,
}

#[derive(Debug, Clone)]
pub struct Store {
    paths: StorePaths,
}

pub struct LockedStore<'a> {
    store: &'a Store,
    _lock: DeploymentLock,
}

impl Store {
    pub fn open(checkout: &Path, port: DeployPort) -> Result<Self> {
        let paths = StorePaths::new(checkout, port)?;
        paths.initialize()?;
        Ok(Self { paths })
    }

    pub fn paths(&self) -> &StorePaths {
        &self.paths
    }

    pub fn lock(&self) -> Result<LockedStore<'_>> {
        Ok(LockedStore {
            store: self,
            _lock: DeploymentLock::try_acquire(&self.paths)?,
        })
    }

    pub fn staging_parent(&self) -> &Path {
        self.paths.generations_dir()
    }

    fn begin_generation_locked(&self) -> Result<GenerationStage> {
        let path = self
            .paths
            .generations_dir()
            .join(format!(".stage-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        sync_directory(&path)?;
        sync_directory(self.paths.generations_dir())?;
        Ok(GenerationStage {
            store: self.clone(),
            path,
            manifest: None,
            published: false,
        })
    }

    fn canonical_disjoint_tree_source(
        &self,
        source: &Path,
        stage: Option<&Path>,
    ) -> Result<PathBuf> {
        let source_metadata = fs::symlink_metadata(source)?;
        if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
            return Err(DeployError::UnsafeStorePath(source.to_path_buf()));
        }
        let canonical_source = fs::canonicalize(source)?;
        for protected in [Some(self.paths.store_root()), stage].into_iter().flatten() {
            if canonical_source.starts_with(protected) || protected.starts_with(&canonical_source) {
                return Err(DeployError::UnsafeStorePath(canonical_source));
            }
        }
        Ok(canonical_source)
    }

    pub fn generation_path(&self, id: &str) -> Result<PathBuf> {
        validate_generation_id(id)?;
        Ok(self.paths.generations_dir().join(id))
    }

    pub fn verify_generation(&self, id: &str) -> Result<Generation> {
        let path = self.generation_path(id)?;
        let metadata = fs::symlink_metadata(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => DeployError::GenerationMissing(id.to_string()),
            _ => error.into(),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DeployError::UnsafeStorePath(path));
        }
        let root_mode = metadata.mode() & 0o7777;
        if root_mode != 0o500 {
            return Err(DeployError::ModeMismatch {
                path,
                expected: 0o500,
                actual: root_mode,
            });
        }
        let manifest = GenerationManifest::read(&path.join(MANIFEST_FILE_NAME))?;
        if manifest.generation_id != id {
            return Err(DeployError::InvalidManifest(
                "manifest identity does not match generation directory".to_string(),
            ));
        }
        verify_sealed_tree(&path, &manifest)?;
        Ok(Generation {
            id: id.to_string(),
            path,
            manifest,
        })
    }

    fn select_generation_locked(&self, id: &str) -> Result<()> {
        self.verify_generation(id)?;
        let target = Path::new("generations").join(id);
        atomic_symlink(self.paths.current_pointer(), &target)
    }

    pub fn selected_generation_id(&self) -> Result<Option<String>> {
        let target = match fs::read_link(self.paths.current_pointer()) {
            Ok(target) => target,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut components = target.components();
        let valid =
            components.next().and_then(|part| part.as_os_str().to_str()) == Some("generations");
        let id = components
            .next()
            .and_then(|part| part.as_os_str().to_str())
            .map(str::to_string);
        if !valid || components.next().is_some() || id.is_none() || target.is_absolute() {
            return Err(DeployError::InvalidReceipt(format!(
                "invalid current pointer target {}",
                target.display()
            )));
        }
        let id = id.expect("checked above");
        validate_generation_id(&id)?;
        self.verify_generation(&id)?;
        Ok(Some(id))
    }

    fn write_live_locked(&self, receipt: &LiveReceipt) -> Result<()> {
        receipt.validate()?;
        self.validate_process_port(receipt.process_identity.as_ref(), "live")?;
        let selected = self.selected_generation_id()?.ok_or_else(|| {
            DeployError::InvalidReceipt("cannot write live receipt without current".to_string())
        })?;
        if selected != receipt.selected_generation_id {
            return Err(DeployError::InvalidReceipt(
                "selectedGenerationId does not match current".to_string(),
            ));
        }
        self.verify_generation(&receipt.selected_generation_id)?;
        self.validate_running_binding(receipt)?;
        atomic_write(self.paths.live_receipt(), &receipt.to_json()?, 0o600)
    }

    pub fn read_live(&self) -> Result<Option<LiveReceipt>> {
        let path = self.paths.live_receipt();
        let Some(bytes) = read_private_receipt(path)? else {
            return Ok(None);
        };
        let receipt = LiveReceipt::from_json(&bytes)?;
        self.validate_process_port(receipt.process_identity.as_ref(), "live")?;
        self.validate_running_binding(&receipt)?;
        Ok(Some(receipt))
    }

    fn write_legacy_capture_locked(&self, receipt: &LegacyCaptureReceipt) -> Result<()> {
        receipt.validate()?;
        self.validate_process_port(Some(&receipt.process), "legacy")?;
        self.verify_generation(&receipt.generation_id)?;
        if let Some(existing) = self.read_legacy_capture()? {
            if existing == *receipt {
                return sync_directory(self.paths.port_root());
            }
            return Err(DeployError::InvalidReceipt(
                "legacy recovery receipt is immutable once created".to_string(),
            ));
        }
        atomic_write_new(self.paths.legacy_receipt(), &receipt.to_json()?, 0o600)
    }

    pub fn read_legacy_capture(&self) -> Result<Option<LegacyCaptureReceipt>> {
        let path = self.paths.legacy_receipt();
        let Some(bytes) = read_private_receipt(path)? else {
            return Ok(None);
        };
        let receipt = LegacyCaptureReceipt::from_json(&bytes)?;
        self.validate_process_port(Some(&receipt.process), "legacy")?;
        Ok(Some(receipt))
    }

    pub(crate) fn install_legacy_controller(&self, source: &Path) -> Result<()> {
        let canonical_source = fs::canonicalize(source)?;
        let source_metadata = fs::symlink_metadata(&canonical_source)?;
        if !source_metadata.is_file() || source_metadata.file_type().is_symlink() {
            return Err(DeployError::UnsafeStorePath(canonical_source));
        }
        let bytes = fs::read(&canonical_source)?;
        let destination = self.paths.legacy_controller();
        match fs::symlink_metadata(destination) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.mode() & 0o7777 != 0o500
                {
                    return Err(DeployError::UnsafeStorePath(destination.to_path_buf()));
                }
                let installed = crate::process_identity::FileIdentity::from_path(destination)?;
                let source = crate::manifest::sha256_bytes(&bytes);
                if installed.sha256 != source {
                    return Err(DeployError::InvalidReceipt(
                        "captured legacy recovery controller is immutable and differs from the executing controller"
                            .to_string(),
                    ));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        atomic_write_new(destination, &bytes, 0o500)
    }

    fn remove_generation_locked(&self, id: &str) -> Result<()> {
        let generation = self.verify_generation(id)?;
        if let Some(transaction) =
            DurableTransactionJournal::new(self.paths.transaction_journal())?.load()?
        {
            if transaction.prior_generation_id == id || transaction.target_generation_id == id {
                return Err(DeployError::TransactionGeneration(id.to_string()));
            }
        }
        let selected = self.selected_generation_id()?;
        if selected.as_deref() == Some(id) {
            return Err(DeployError::SelectedGeneration(id.to_string()));
        }
        let live = self.read_live()?.ok_or_else(|| {
            DeployError::InvalidReceipt(
                "authoritative live receipt is missing; cleanup fails closed".to_string(),
            )
        })?;
        if selected.as_deref() != Some(live.selected_generation_id.as_str()) {
            return Err(DeployError::InvalidReceipt(
                "live selectedGenerationId does not match current".to_string(),
            ));
        }
        if let Some(running) = live.running_server_generation_id {
            self.verify_generation(&running)?;
            if running == id {
                return Err(DeployError::RunningGeneration(id.to_string()));
            }
        }
        if let Some(legacy) = self.read_legacy_capture()? {
            self.verify_generation(&legacy.generation_id)?;
            if legacy.generation_id == id {
                return Err(DeployError::LegacyGeneration(id.to_string()));
            }
        }
        remove_manifested_tree(&generation.path, &generation.manifest)?;
        sync_directory(self.paths.generations_dir()).map_err(|error| {
            DeployError::StorageAmbiguous {
                operation: "generation cleanup parent sync",
                path: generation.path,
                cause: error.to_string(),
            }
        })
    }

    fn prune_generations_locked(&self, retain_unprotected: usize) -> Result<Vec<String>> {
        let selected = self.selected_generation_id()?;
        let live = self.read_live()?;
        if let Some(live) = &live {
            if selected.as_deref() != Some(live.selected_generation_id.as_str()) {
                return Err(DeployError::InvalidReceipt(
                    "live selectedGenerationId does not match current".to_string(),
                ));
            }
        } else if selected.is_some() && self.read_legacy_capture()?.is_some() {
            return Err(DeployError::InvalidReceipt(
                "captured legacy selection is missing its authoritative live receipt".to_string(),
            ));
        }

        let mut protected = BTreeSet::new();
        if let Some(selected) = selected {
            protected.insert(selected);
        }
        if let Some(live) = live {
            if let Some(running) = live.running_server_generation_id {
                self.verify_generation(&running)?;
                protected.insert(running);
            }
        }
        if let Some(legacy) = self.read_legacy_capture()? {
            self.verify_generation(&legacy.generation_id)?;
            protected.insert(legacy.generation_id);
        }
        if let Some(transaction) =
            DurableTransactionJournal::new(self.paths.transaction_journal())?.load()?
        {
            self.verify_generation(&transaction.prior_generation_id)?;
            self.verify_generation(&transaction.target_generation_id)?;
            protected.insert(transaction.prior_generation_id);
            protected.insert(transaction.target_generation_id);
        }

        let mut unprotected = Vec::new();
        for entry in fs::read_dir(self.paths.generations_dir())? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str() else {
                return Err(DeployError::UnsafeStorePath(entry.path()));
            };
            if id.starts_with(".stage-") {
                continue;
            }
            validate_generation_id(id)?;
            let generation = self.verify_generation(id)?;
            if !protected.contains(id) {
                unprotected.push((
                    fs::symlink_metadata(&generation.path)?.modified()?,
                    id.to_string(),
                    generation,
                ));
            }
        }
        unprotected.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));

        let mut removed = Vec::new();
        for (_, id, generation) in unprotected.into_iter().skip(retain_unprotected) {
            remove_manifested_tree(&generation.path, &generation.manifest)?;
            sync_directory(self.paths.generations_dir()).map_err(|error| {
                DeployError::StorageAmbiguous {
                    operation: "generation retention parent sync",
                    path: generation.path,
                    cause: error.to_string(),
                }
            })?;
            removed.push(id);
        }
        Ok(removed)
    }

    fn validate_process_port(
        &self,
        process: Option<&crate::process_identity::ProcessIdentity>,
        receipt_name: &str,
    ) -> Result<()> {
        if let Some(process) = process {
            if process.listener.port != self.paths.port() {
                return Err(DeployError::InvalidReceipt(format!(
                    "{receipt_name} process listener port {} does not match store port {}",
                    process.listener.port,
                    self.paths.port()
                )));
            }
        }
        Ok(())
    }

    fn validate_running_binding(&self, receipt: &LiveReceipt) -> Result<()> {
        let (Some(generation_id), Some(process)) = (
            receipt.running_server_generation_id.as_deref(),
            receipt.process_identity.as_ref(),
        ) else {
            return Ok(());
        };
        let generation = self.verify_generation(generation_id)?;
        let executable_path = generation.path.join("server/freshell-server");
        let copied_executable = crate::process_identity::FileIdentity::from_path(&executable_path)
            .map_err(|error| {
                DeployError::InvalidReceipt(format!(
                    "running generation server executable is invalid: {error}"
                ))
            })?;
        if receipt.legacy {
            let legacy = self.read_legacy_capture()?.ok_or_else(|| {
                DeployError::InvalidReceipt(
                    "legacy live binding requires authoritative legacy.json".to_string(),
                )
            })?;
            if legacy.generation_id != generation_id || legacy.process != *process {
                return Err(DeployError::InvalidReceipt(
                    "legacy live process/generation binding disagrees with legacy.json".to_string(),
                ));
            }
            if copied_executable.sha256 != process.executable.sha256
                || copied_executable.mode != process.executable.mode & !0o222
            {
                return Err(DeployError::InvalidReceipt(
                    "legacy generation executable does not match captured live process".to_string(),
                ));
            }
            return Ok(());
        }
        if copied_executable != process.executable {
            return Err(DeployError::InvalidReceipt(
                "running process executable is not the claimed generation executable".to_string(),
            ));
        }
        if Path::new(&process.cwd) != generation.path {
            return Err(DeployError::InvalidReceipt(
                "running process cwd is not the claimed generation root".to_string(),
            ));
        }
        let client = Path::new(&process.runtime.client_dir);
        let selected_client = self.paths.current_pointer().join("client");
        if client != selected_client {
            return Err(DeployError::InvalidReceipt(
                "running managed process client provenance is not the stable current/client indirection"
                    .to_string(),
            ));
        }
        for (label, actual) in [
            ("extensions", &process.runtime.extensions_dir),
            ("compiled server", &process.runtime.dist_server_dir),
            ("MCP entry", &process.runtime.mcp_entry),
            ("Claude sidecar", &process.runtime.claude_sidecar_entry),
            ("package.json", &process.runtime.package_json),
            ("package-lock.json", &process.runtime.package_lock),
            (
                "production dependencies",
                &process.runtime.production_node_modules,
            ),
        ] {
            if !is_strict_generation_path(Path::new(actual), &generation.path) {
                return Err(DeployError::InvalidReceipt(format!(
                    "running process {label} provenance is outside the claimed generation"
                )));
            }
        }
        Ok(())
    }
}

fn is_strict_generation_path(path: &Path, root: &Path) -> bool {
    path.is_absolute()
        && path != root
        && path.starts_with(root)
        && path.components().all(|component| {
            matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
}

fn read_private_receipt(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

impl LockedStore<'_> {
    pub fn begin_generation(&self) -> Result<GenerationStage> {
        self.store.begin_generation_locked()
    }

    pub fn import_tree(&self, source: &Path) -> Result<Generation> {
        let canonical_source = self.store.canonical_disjoint_tree_source(source, None)?;
        let mut stage = self.begin_generation()?;
        stage.copy_tree(&canonical_source, Path::new(""))?;
        stage.seal()?;
        self.publish(stage)
    }

    pub fn publish(&self, stage: GenerationStage) -> Result<Generation> {
        self.require_own_stage(&stage)?;
        stage.publish_inner(false)
    }

    pub(crate) fn publish_or_reuse(&self, stage: GenerationStage) -> Result<Generation> {
        self.require_own_stage(&stage)?;
        stage.publish_inner(true)
    }

    pub fn select_generation(&self, id: &str) -> Result<()> {
        self.store.select_generation_locked(id)
    }

    pub fn write_live(&self, receipt: &LiveReceipt) -> Result<()> {
        self.store.write_live_locked(receipt)
    }

    pub fn write_legacy_capture(&self, receipt: &LegacyCaptureReceipt) -> Result<()> {
        self.store.write_legacy_capture_locked(receipt)
    }

    pub fn remove_generation(&self, id: &str) -> Result<()> {
        self.store.remove_generation_locked(id)
    }

    pub fn prune_generations(&self, retain_unprotected: usize) -> Result<Vec<String>> {
        self.store.prune_generations_locked(retain_unprotected)
    }

    fn require_own_stage(&self, stage: &GenerationStage) -> Result<()> {
        if stage.store.paths.port_root() != self.store.paths.port_root()
            || stage.store.paths.checkout() != self.store.paths.checkout()
        {
            return Err(DeployError::UnsafeStorePath(stage.path.clone()));
        }
        Ok(())
    }
}

pub struct GenerationStage {
    store: Store,
    path: PathBuf,
    manifest: Option<GenerationManifest>,
    published: bool,
}

impl GenerationStage {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn copy_tree(&mut self, source: &Path, destination: &Path) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(destination, true)?;
        let source = self
            .store
            .canonical_disjoint_tree_source(source, Some(&self.path))?;
        let metadata = fs::symlink_metadata(&source)?;
        let destination_root = self.path.join(destination);
        if !destination.as_os_str().is_empty() {
            let parent = destination_root
                .parent()
                .expect("non-empty stage destination has a parent");
            create_stage_directories(&self.path, parent)?;
            fs::create_dir(&destination_root)?;
        }
        copy_directory_contents(&source, &destination_root, destination)?;
        if !destination.as_os_str().is_empty() {
            fs::set_permissions(
                &destination_root,
                fs::Permissions::from_mode(metadata.mode() & 0o7777),
            )?;
            sync_directory(&destination_root)?;
        }
        Ok(())
    }

    pub(crate) fn copy_tree_excluding_top_level(
        &mut self,
        source: &Path,
        destination: &Path,
        excluded: &Path,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(destination, true)?;
        validate_relative_path(excluded, false)?;
        if excluded.components().count() != 1 {
            return Err(DeployError::UnsafeRelativePath(excluded.to_path_buf()));
        }
        let source = self
            .store
            .canonical_disjoint_tree_source(source, Some(&self.path))?;
        let metadata = fs::symlink_metadata(&source)?;
        let destination_root = self.path.join(destination);
        if !destination.as_os_str().is_empty() {
            let parent = destination_root
                .parent()
                .expect("non-empty stage destination has a parent");
            create_stage_directories(&self.path, parent)?;
            fs::create_dir(&destination_root)?;
        }
        copy_directory_contents_excluding(
            &source,
            &destination_root,
            destination,
            excluded.as_os_str(),
        )?;
        if !destination.as_os_str().is_empty() {
            fs::set_permissions(
                &destination_root,
                fs::Permissions::from_mode(metadata.mode() & 0o7777),
            )?;
            sync_directory(&destination_root)?;
        }
        Ok(())
    }

    pub(crate) fn copy_generation_tree(
        &mut self,
        generation: &Generation,
        source: &Path,
        destination: &Path,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(source, false)?;
        validate_relative_path(destination, false)?;
        let verified = self.store.verify_generation(&generation.id)?;
        if verified.path != generation.path || verified.manifest != generation.manifest {
            return Err(DeployError::InvalidManifest(
                "generation composition source changed after verification".to_string(),
            ));
        }
        let source_root = generation.path.join(source);
        let metadata = fs::symlink_metadata(&source_root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DeployError::TypeMismatch(source_root));
        }
        let destination_root = self.path.join(destination);
        let parent = destination_root
            .parent()
            .expect("validated destination has a parent");
        create_stage_directories(&self.path, parent)?;
        fs::create_dir(&destination_root)?;
        copy_directory_contents(&source_root, &destination_root, destination)?;
        fs::set_permissions(
            &destination_root,
            fs::Permissions::from_mode(metadata.mode() & 0o7777),
        )?;
        sync_directory(&destination_root)
    }

    pub(crate) fn copy_generation_file(
        &mut self,
        generation: &Generation,
        source: &Path,
        destination: &Path,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(source, false)?;
        validate_relative_path(destination, false)?;
        let verified = self.store.verify_generation(&generation.id)?;
        if verified.path != generation.path || verified.manifest != generation.manifest {
            return Err(DeployError::InvalidManifest(
                "generation composition source changed after verification".to_string(),
            ));
        }
        let source_path = generation.path.join(source);
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(DeployError::TypeMismatch(source_path));
        }
        self.copy_file(&source_path, destination, metadata.mode() & 0o7777)
    }

    pub(crate) fn merge_generation_assets(
        &mut self,
        generation: &Generation,
        source: &Path,
        destination: &Path,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(source, false)?;
        validate_relative_path(destination, false)?;
        let verified = self.store.verify_generation(&generation.id)?;
        if verified.path != generation.path || verified.manifest != generation.manifest {
            return Err(DeployError::InvalidManifest(
                "generation asset source changed after verification".to_string(),
            ));
        }
        merge_missing_assets(
            &generation.path.join(source),
            &self.path.join(destination),
            &self.path,
        )
    }

    pub(crate) fn merge_generation_asset_file(
        &mut self,
        generation: &Generation,
        path: &Path,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(path, false)?;
        let verified = self.store.verify_generation(&generation.id)?;
        if verified.path != generation.path || verified.manifest != generation.manifest {
            return Err(DeployError::InvalidManifest(
                "generation asset source changed after verification".to_string(),
            ));
        }
        let source = generation.path.join(path);
        let source_metadata = fs::symlink_metadata(&source)?;
        if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
            return Err(DeployError::InvalidManifest(format!(
                "selected client asset is not a regular file: {}",
                source.display()
            )));
        }
        let destination = self.path.join(path);
        match fs::symlink_metadata(&destination) {
            Ok(destination_metadata)
                if destination_metadata.is_file()
                    && !destination_metadata.file_type().is_symlink()
                    && source_metadata.mode() & 0o7555 == destination_metadata.mode() & 0o7555
                    && crate::manifest::sha256_file(&source)?
                        == crate::manifest::sha256_file(&destination)? =>
            {
                Ok(())
            }
            Ok(_) => Err(DeployError::InvalidManifest(format!(
                "candidate client asset conflicts with retained asset {}",
                destination.display()
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.copy_file(&source, path, source_metadata.mode() & 0o7777)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn copy_file(&mut self, source: &Path, destination: &Path, mode: u32) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(destination, false)?;
        let parent = self.path.join(destination).parent().unwrap().to_path_buf();
        create_stage_directories(&self.path, &parent)?;
        copy_regular_file(source, &self.path.join(destination), mode)
    }

    pub fn copy_open_file(
        &mut self,
        source: &mut File,
        destination: &Path,
        mode: u32,
    ) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(destination, false)?;
        source.seek(SeekFrom::Start(0))?;
        let parent = self.path.join(destination).parent().unwrap().to_path_buf();
        create_stage_directories(&self.path, &parent)?;
        copy_open_file(source, &self.path.join(destination), mode)
    }

    pub fn write_bytes(&mut self, destination: &Path, bytes: &[u8], mode: u32) -> Result<()> {
        self.require_unsealed()?;
        validate_relative_path(destination, false)?;
        let full_path = self.path.join(destination);
        let parent = full_path.parent().unwrap();
        create_stage_directories(&self.path, parent)?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .open(&full_path)?;
        file.write_all(bytes)?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        sync_directory(parent)
    }

    pub fn seal(&mut self) -> Result<&GenerationManifest> {
        self.require_unsealed()?;
        match fs::symlink_metadata(self.path.join(MANIFEST_FILE_NAME)) {
            Ok(_) => {
                return Err(DeployError::InvalidManifest(format!(
                    "{MANIFEST_FILE_NAME} is reserved for the authoritative generation manifest"
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        make_children_immutable(&self.path)?;
        let manifest = GenerationManifest::build(&self.path)?;
        atomic_write(
            &self.path.join(MANIFEST_FILE_NAME),
            &manifest.to_json()?,
            0o444,
        )?;
        fs::set_permissions(&self.path, fs::Permissions::from_mode(0o500))?;
        sync_directory(&self.path)?;
        self.manifest = Some(manifest);
        Ok(self.manifest.as_ref().expect("just assigned"))
    }

    pub fn manifest(&self) -> Option<&GenerationManifest> {
        self.manifest.as_ref()
    }

    fn publish_inner(mut self, allow_matching_existing: bool) -> Result<Generation> {
        let manifest = self
            .manifest
            .as_ref()
            .ok_or_else(|| DeployError::InvalidManifest("generation is not sealed".to_string()))?
            .clone();
        verify_sealed_tree(&self.path, &manifest)?;
        let id = manifest.generation_id.clone();
        let destination = self.store.generation_path(&id)?;
        match fs::symlink_metadata(&destination) {
            Ok(_) if allow_matching_existing => {
                let existing = self.store.verify_generation(&id)?;
                if existing.manifest != manifest {
                    return Err(DeployError::InvalidManifest(format!(
                        "existing generation {id} does not match the sealed bootstrap stage"
                    )));
                }
                sync_directory(self.store.paths.generations_dir())?;
                return Ok(existing);
            }
            Ok(_) => return Err(DeployError::GenerationExists(id)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = rename_noreplace(&self.path, &destination) {
            if matches!(
                &error,
                DeployError::Io(io_error)
                    if matches!(
                        io_error.raw_os_error(),
                        Some(libc::EEXIST) | Some(libc::ENOTEMPTY)
                    )
            ) {
                if allow_matching_existing {
                    let existing = self.store.verify_generation(&id)?;
                    if existing.manifest == manifest {
                        sync_directory(self.store.paths.generations_dir())?;
                        return Ok(existing);
                    }
                }
                return Err(DeployError::GenerationExists(id));
            }
            return Err(error);
        }
        self.published = true;
        sync_directory(self.store.paths.generations_dir()).map_err(|error| {
            DeployError::StorageAmbiguous {
                operation: "generation publication parent sync",
                path: destination.clone(),
                cause: error.to_string(),
            }
        })?;
        Ok(Generation {
            id,
            path: destination,
            manifest,
        })
    }

    fn require_unsealed(&self) -> Result<()> {
        if self.manifest.is_some() {
            return Err(DeployError::InvalidManifest(
                "generation stage is already sealed".to_string(),
            ));
        }
        Ok(())
    }
}

impl Drop for GenerationStage {
    fn drop(&mut self) {
        if !self.published && self.path.starts_with(self.store.paths.generations_dir()) {
            let safely_removed = self
                .manifest
                .as_ref()
                .is_some_and(|manifest| remove_manifested_tree(&self.path, manifest).is_ok());
            if safely_removed {
                let _ = sync_directory(self.store.paths.generations_dir());
            }
        }
    }
}

fn copy_directory_contents(source: &Path, destination: &Path, relative_base: &Path) -> Result<()> {
    let mut children = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        let source_path = child.path();
        let relative = relative_base.join(child.file_name());
        validate_relative_path(&relative, false)?;
        let destination_path = destination.join(child.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&source_path)?;
            validate_symlink_target(&relative, &target)?;
            symlink(target, &destination_path)?;
            sync_directory(destination)?;
        } else if metadata.is_dir() {
            fs::create_dir(&destination_path)?;
            copy_directory_contents(&source_path, &destination_path, &relative)?;
            fs::set_permissions(
                &destination_path,
                fs::Permissions::from_mode(metadata.mode() & 0o7777),
            )?;
            sync_directory(&destination_path)?;
        } else if metadata.is_file() {
            copy_regular_file(&source_path, &destination_path, metadata.mode() & 0o7777)?;
        } else {
            return Err(DeployError::InvalidManifest(format!(
                "special files are not allowed: {}",
                source_path.display()
            )));
        }
    }
    Ok(())
}

fn copy_directory_contents_excluding(
    source: &Path,
    destination: &Path,
    relative_base: &Path,
    excluded: &std::ffi::OsStr,
) -> Result<()> {
    let mut children = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        if child.file_name() == excluded {
            continue;
        }
        copy_tree_entry(
            &child.path(),
            &destination.join(child.file_name()),
            relative_base,
        )?;
    }
    sync_directory(destination)
}

fn copy_tree_entry(source: &Path, destination: &Path, relative_parent: &Path) -> Result<()> {
    let name = source
        .file_name()
        .ok_or_else(|| DeployError::UnsafeStorePath(source.to_path_buf()))?;
    let relative = relative_parent.join(name);
    validate_relative_path(&relative, false)?;
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(source)?;
        validate_symlink_target(&relative, &target)?;
        symlink(target, destination)?;
    } else if metadata.is_dir() {
        fs::create_dir(destination)?;
        copy_directory_contents(source, destination, &relative)?;
        fs::set_permissions(
            destination,
            fs::Permissions::from_mode(metadata.mode() & 0o7777),
        )?;
        sync_directory(destination)?;
    } else if metadata.is_file() {
        copy_regular_file(source, destination, metadata.mode() & 0o7777)?;
    } else {
        return Err(DeployError::InvalidManifest(format!(
            "special files are not allowed: {}",
            source.display()
        )));
    }
    Ok(())
}

fn merge_missing_assets(source: &Path, destination: &Path, stage_root: &Path) -> Result<()> {
    let source_metadata = fs::symlink_metadata(source)?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(DeployError::InvalidManifest(
            "selected client assets are not a real directory".to_string(),
        ));
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = destination
                .parent()
                .ok_or_else(|| DeployError::UnsafeStorePath(destination.to_path_buf()))?;
            create_stage_directories(stage_root, parent)?;
            fs::create_dir(destination)?;
        }
        _ => {
            return Err(DeployError::InvalidManifest(
                "candidate client assets are not a real directory".to_string(),
            ))
        }
    }
    let mut children = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        let source_path = child.path();
        let destination_path = destination.join(child.file_name());
        let source_metadata = fs::symlink_metadata(&source_path)?;
        if source_metadata.file_type().is_symlink() {
            return Err(DeployError::InvalidManifest(format!(
                "selected client asset is a symlink: {}",
                source_path.display()
            )));
        }
        match fs::symlink_metadata(&destination_path) {
            Ok(destination_metadata) => {
                if source_metadata.is_dir() && destination_metadata.is_dir() {
                    merge_missing_assets(&source_path, &destination_path, stage_root)?;
                } else if source_metadata.is_file()
                    && destination_metadata.is_file()
                    && source_metadata.mode() & 0o7555 == destination_metadata.mode() & 0o7555
                    && crate::manifest::sha256_file(&source_path)?
                        == crate::manifest::sha256_file(&destination_path)?
                {
                    continue;
                } else {
                    return Err(DeployError::InvalidManifest(format!(
                        "candidate client asset conflicts with retained asset {}",
                        destination_path.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if source_metadata.is_dir() {
                    fs::create_dir(&destination_path)?;
                    merge_missing_assets(&source_path, &destination_path, stage_root)?;
                    fs::set_permissions(
                        &destination_path,
                        fs::Permissions::from_mode(source_metadata.mode() & 0o7777),
                    )?;
                } else if source_metadata.is_file() {
                    copy_regular_file(
                        &source_path,
                        &destination_path,
                        source_metadata.mode() & 0o7777,
                    )?;
                } else {
                    return Err(DeployError::InvalidManifest(format!(
                        "selected client asset is special: {}",
                        source_path.display()
                    )));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    sync_directory(destination)
}

fn create_stage_directories(stage_root: &Path, destination: &Path) -> Result<()> {
    let relative = destination
        .strip_prefix(stage_root)
        .map_err(|_| DeployError::UnsafeRelativePath(destination.to_path_buf()))?;
    let mut current = stage_root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(DeployError::UnsafeStorePath(current)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                sync_directory(current.parent().expect("stage child parent"))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn make_children_immutable(root: &Path) -> Result<()> {
    let mut children = fs::read_dir(root)?.collect::<std::io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name().as_bytes().to_vec());
    for child in children {
        let path = child.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            make_children_immutable(&path)?;
        }
        let immutable_mode = (metadata.mode() & 0o7777) & !0o222;
        fs::set_permissions(&path, fs::Permissions::from_mode(immutable_mode))?;
        if metadata.is_file() {
            File::open(&path)?.sync_all()?;
        } else {
            sync_directory(&path)?;
        }
    }
    Ok(())
}

fn remove_manifested_tree(root: &Path, manifest: &GenerationManifest) -> Result<()> {
    verify_sealed_tree(root, manifest)?;
    let destructive_result: Result<()> = (|| {
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        let mut files = Vec::new();
        let mut directories = Vec::new();
        for entry in &manifest.entries {
            let path = root.join(&entry.path);
            match entry.kind {
                crate::manifest::EntryKind::Directory => directories.push(path),
                crate::manifest::EntryKind::File | crate::manifest::EntryKind::Symlink => {
                    files.push(path)
                }
            }
        }
        directories.sort_by_key(|path| path.components().count());
        for path in &directories {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
        files.push(root.join(MANIFEST_FILE_NAME));
        for path in files {
            fs::remove_file(path)?;
        }
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for path in directories {
            fs::remove_dir(path)?;
        }
        fs::remove_dir(root)?;
        Ok(())
    })();
    destructive_result.map_err(|error| DeployError::StorageAmbiguous {
        operation: "generation tree cleanup",
        path: root.to_path_buf(),
        cause: error.to_string(),
    })
}

fn verify_sealed_tree(root: &Path, manifest: &GenerationManifest) -> Result<()> {
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(DeployError::UnsafeStorePath(root.to_path_buf()));
    }
    let root_mode = root_metadata.mode() & 0o7777;
    if root_mode != 0o500 {
        return Err(DeployError::ModeMismatch {
            path: root.to_path_buf(),
            expected: 0o500,
            actual: root_mode,
        });
    }
    let disk_manifest = GenerationManifest::read(&root.join(MANIFEST_FILE_NAME))?;
    if &disk_manifest != manifest {
        return Err(DeployError::InvalidManifest(
            "on-disk manifest changed after sealing".to_string(),
        ));
    }
    manifest.verify_tree(root)?;
    let revalidated_root = fs::symlink_metadata(root)?;
    if revalidated_root.file_type().is_symlink()
        || !revalidated_root.is_dir()
        || revalidated_root.dev() != root_metadata.dev()
        || revalidated_root.ino() != root_metadata.ino()
        || revalidated_root.mode() & 0o7777 != 0o500
    {
        return Err(DeployError::UnsafeStorePath(root.to_path_buf()));
    }
    Ok(())
}
