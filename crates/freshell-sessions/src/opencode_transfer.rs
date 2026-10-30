//! Exact-session OpenCode history export.
//!
//! The source is selected from trusted host inventory, opened read-only, and
//! copied through SQLite's Online Backup API into a private local extraction
//! directory. The backup is only an extraction intermediate: the returned
//! payload is a new JSON document containing the selected session closure,
//! never a copy of the host database.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::backup::{Backup, Progress, StepResult};
use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

use crate::provider_layout::ProviderLayout;

const EXPORT_VERSION: u32 = 2;
const OPENCODE_SCHEMA_VERSION: &str = "opencode-1.18.21";
const PINNED_SCHEMA_SQL: &str = include_str!("opencode_schema_v1_18_21.sql");
const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const PAYLOAD_WRITE_BUFFER_BYTES: usize = 64 * 1024;
const MAX_SOURCE_CANDIDATES: usize = 32;
const EXTRACT_DIR_PREFIX: &str = "opencode-extract-";

const REQUIRED_TABLES: &[&str] = &[
    "project",
    "workspace",
    "project_directory",
    "permission",
    "session",
    "message",
    "part",
    "event_sequence",
    "event",
    "session_message",
    "session_input",
    "session_context_epoch",
    "todo",
    "migration",
    "data_migration",
];

// These are native v1.18.21 tables, but they are not dependencies of the
// selected native conversation and can contain credentials or unrelated
// provider/account state. `message_seq` and `provider_config` are exact
// synthetic compatibility fixtures: the former is the fake CLI's derived
// append counter, not an OpenCode v1.18.21 table; the latter proves that
// configuration rows do not enter the transfer payload.
const OMITTABLE_TABLES: &[&str] = &[
    "account",
    "account_state",
    "control_account",
    "credential",
    "data_migration",
    "migration",
    "session_share",
    "message_seq",
    "provider_config",
];

// OpenCode v1.18.21's checked-in migration registry. A database with a
// partial, future, or otherwise unknown registry is not a supported source
// schema even if its current table names happen to look familiar.
const PINNED_MIGRATIONS: &[&str] = &[
    "20260127222353_familiar_lady_ursula",
    "20260211171708_add_project_commands",
    "20260213144116_wakeful_the_professor",
    "20260225215848_workspace",
    "20260227213759_add_session_workspace_id",
    "20260228203230_blue_harpoon",
    "20260303231226_add_workspace_fields",
    "20260309230000_move_org_to_state",
    "20260312043431_session_message_cursor",
    "20260323234822_events",
    "20260410174513_workspace-name",
    "20260413175956_chief_energizer",
    "20260423070820_add_icon_url_override",
    "20260427172553_slow_nightmare",
    "20260428004200_add_session_path",
    "20260501142318_next_venus",
    "20260504145000_add_sync_owner",
    "20260507164347_add_workspace_time",
    "20260510033149_session_usage",
    "20260511000411_data_migration_state",
    "20260511173437_session-metadata",
    "20260601010001_normalize_storage_paths",
    "20260601202201_amazing_prowler",
    "20260602002951_lowly_union_jack",
    "20260602182828_add_project_directories",
    "20260603001617_session_message_projection_indexes",
    "20260603040000_session_message_projection_order",
    "20260603141458_session_input_inbox",
    "20260603160727_jittery_ezekiel_stane",
    "20260604172448_event_sourced_session_input",
    "20260605003541_add_session_context_snapshot",
    "20260605042240_add_context_epoch_agent",
    "20260611035744_credential",
    "20260611192811_lush_chimera",
    "20260612174303_project_dir_strategy",
    "20260622142730_simplify_session_context_epoch",
    "20260622170816_reset_v2_session_state",
    "20260622202450_simplify_session_input",
];

// The pinned v1.18.21 source creates this journal table but registers no data
// migrations that write to it. Its only supported state is therefore empty.
// When the provider adds one, its exact name/state must be qualified here.
const PINNED_DATA_MIGRATIONS: &[&str] = &[];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferError {
    Blocked(String),
    Io(String),
    Sqlite(String),
    Serialization(String),
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blocked(reason) => write!(f, "OpenCode transfer blocked: {reason}"),
            Self::Io(reason) => write!(f, "OpenCode transfer I/O error: {reason}"),
            Self::Sqlite(reason) => write!(f, "OpenCode transfer SQLite error: {reason}"),
            Self::Serialization(reason) => {
                write!(f, "OpenCode transfer serialization error: {reason}")
            }
        }
    }
}

impl std::error::Error for TransferError {}

impl From<rusqlite::Error> for TransferError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error.to_string())
    }
}

impl From<io::Error> for TransferError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// Host-side source inventory. Callers populate channel databases from the
/// trusted OpenCode session inventory; this type is not a client request.
/// An effective `OPENCODE_DB` override selects one database. Without it, the
/// discovered installation-channel stores are searched, falling back to the
/// host's normal data-home database only when no channel store was found.
#[derive(Debug, Clone)]
pub struct HostOpenCodeInventory {
    effective_database_override: Option<OsString>,
    working_directory: PathBuf,
    default_database: PathBuf,
    channel_databases: Vec<PathBuf>,
    workspace_mounts: Vec<WorkspaceMountMapping>,
    trusted_directory_mounts: Vec<PathBuf>,
    discovery_root: Option<PathBuf>,
    qualified_snapshot: Option<Box<QualifiedSourceSnapshot>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WorkspaceIdentity {
    project_id: String,
    workspace_id: Option<String>,
    directory: String,
}

#[derive(Debug, Clone)]
struct WorkspaceMountMapping {
    identity: WorkspaceIdentity,
    managed_mount: PathBuf,
}

/// A workspace root resolved from a trusted host inventory and bound to one
/// selected provider session. This type is private so unverified paths cannot
/// be passed directly into file or Git verification.
#[derive(Debug, Clone)]
struct ResolvedWorkspaceMount {
    canonical_root: PathBuf,
    identity: WorkspaceIdentity,
}

impl HostOpenCodeInventory {
    pub fn declared_default_database(&self) -> &Path {
        &self.default_database
    }
    pub fn new(default_database: PathBuf) -> Self {
        Self {
            effective_database_override: None,
            working_directory: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            default_database,
            channel_databases: Vec::new(),
            workspace_mounts: Vec::new(),
            trusted_directory_mounts: Vec::new(),
            discovery_root: None,
            qualified_snapshot: None,
        }
    }

    /// Resolve the process environment and add channel paths discovered by
    /// trusted host-side provider inventory.
    pub fn from_process_environment(channel_databases: Vec<PathBuf>) -> Self {
        let mut inventory =
            Self::new(crate::parse::default_opencode_data_home().join("opencode.db"));
        inventory.effective_database_override =
            std::env::var_os("OPENCODE_DB").filter(|value| !value.is_empty());
        inventory.channel_databases = channel_databases;
        inventory
    }

    /// Build the production inventory from the trusted OpenCode data home.
    /// OpenCode names non-default installation stores `opencode-<channel>.db`;
    /// every such database and the default store must be considered together
    /// so exact-root resolution can reject duplicate ownership.
    pub fn discover_in_data_home(data_home: &Path) -> Result<Self, TransferError> {
        let default_database = crate::provider_layout::OpencodeLayout.session_root(data_home);
        let mut inventory = Self::new(default_database);
        inventory.discovery_root = Some(data_home.to_path_buf());
        let entries = match fs::read_dir(data_home) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(inventory),
            Err(error) => return Err(error.into()),
        };
        let mut databases = Vec::new();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name == "opencode.db"
                || name.strip_prefix("opencode-").is_some_and(|channel_name| {
                    !channel_name.is_empty() && channel_name.ends_with(".db")
                })
            {
                databases.push(path);
            }
        }
        databases.sort();
        databases.dedup();
        inventory.channel_databases = databases;
        Ok(inventory)
    }

    /// Production constructor: an explicit provider override selects exactly
    /// that store; otherwise discover the default and installation-channel
    /// databases from OpenCode's trusted data-home layout.
    pub fn from_process_environment_discovering_channels() -> Result<Self, TransferError> {
        if let Some(value) = std::env::var_os("OPENCODE_DB").filter(|value| !value.is_empty()) {
            let mut inventory =
                Self::new(crate::parse::default_opencode_data_home().join("opencode.db"));
            inventory.effective_database_override = Some(value);
            inventory.working_directory = std::env::current_dir()?;
            return Ok(inventory);
        }
        Self::discover_in_data_home(&crate::parse::default_opencode_data_home())
    }

    pub fn with_channel_database(mut self, path: PathBuf) -> Self {
        self.channel_databases.push(path);
        self
    }

    /// Add a managed mount resolved by the trusted host workspace inventory.
    /// The source identity must come from the selected OpenCode session's
    /// project/workspace/directory records; `managed_mount` must be the host
    /// resolver's corresponding managed workspace root, never a client path.
    /// Export binds this mapping to selected session rows before verifying any
    /// file or Git reference. A plain path without this identity is rejected.
    pub fn with_trusted_workspace_mount(
        mut self,
        project_id: impl Into<String>,
        workspace_id: Option<String>,
        session_directory: impl Into<String>,
        managed_mount: PathBuf,
    ) -> Self {
        self.workspace_mounts.push(WorkspaceMountMapping {
            identity: WorkspaceIdentity {
                project_id: project_id.into(),
                workspace_id,
                directory: session_directory.into(),
            },
            managed_mount,
        });
        self
    }

    /// Bind a trusted managed workspace mount to the selected source session
    /// only when its stored directory exactly matches that canonical mount.
    /// Native project/workspace IDs are read from the immutable source
    /// snapshot inside the exporter; callers never supply source identity.
    pub fn with_trusted_mount_for_selected_session(mut self, managed_mount: PathBuf) -> Self {
        if !self.trusted_directory_mounts.contains(&managed_mount) {
            self.trusted_directory_mounts.push(managed_mount);
        }
        self
    }

    /// Model the effective provider environment in synthetic tests or when
    /// the trusted host inventory has already captured the provider's env.
    pub fn with_effective_database_override(
        mut self,
        value: impl Into<OsString>,
        working_directory: PathBuf,
    ) -> Self {
        self.effective_database_override = Some(value.into());
        self.working_directory = working_directory;
        self
    }

    fn candidates(&self) -> Result<Vec<PathBuf>, TransferError> {
        let mut candidates = if let Some(value) = self
            .effective_database_override
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            let value = PathBuf::from(value);
            if value == Path::new(":memory:") {
                return Err(TransferError::Blocked(
                    "effective OpenCode database is in-memory".into(),
                ));
            }
            vec![if value.is_absolute() {
                value
            } else {
                self.working_directory.join(value)
            }]
        } else if self.channel_databases.is_empty() {
            vec![self.default_database.clone()]
        } else {
            self.channel_databases.clone()
        };

        if candidates.len() > MAX_SOURCE_CANDIDATES {
            return Err(TransferError::Blocked(
                "source inventory exceeds its bounded candidate count".into(),
            ));
        }
        candidates.sort();
        candidates.dedup();
        Ok(candidates)
    }

    fn tool_output_directory(&self, selected_database: &Path) -> PathBuf {
        if let Some(snapshot) = &self.qualified_snapshot {
            return snapshot.tool_output_directory.clone();
        }
        let data_home_database = if self
            .effective_database_override
            .as_ref()
            .is_some_and(|value| !value.is_empty())
        {
            &self.default_database
        } else {
            selected_database
        };
        data_home_database
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("tool-output")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualifiedSnapshotRoot {
    pub root_session_id: String,
    pub graph_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualifiedSnapshotReceipt {
    pub canonical_source_database: PathBuf,
    pub source_store_id: String,
    pub snapshot_sha256: String,
    pub snapshot_bytes: u64,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub roots: Vec<QualifiedSnapshotRoot>,
}

/// Only independent source resolution and a complete consistent capture can
/// construct this value. A caller cannot override a source-store identity.
#[derive(Debug, Clone)]
pub struct QualifiedSourceSnapshot {
    path: PathBuf,
    files: SnapshotFiles,
    receipt: QualifiedSnapshotReceipt,
    tool_output_directory: PathBuf,
    workspace_mounts: Vec<WorkspaceMountMapping>,
    trusted_directory_mounts: Vec<PathBuf>,
    _capture_guard: Option<std::sync::Arc<TempDir>>,
}

// Whole-file integrity is established once when a private snapshot is
// qualified. Each export still checks its complete selected closure and these
// file identities before and after reading. Include WAL/journal changes so a
// SQLite writer cannot silently change a copy without touching its main file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapshotFileIdentity {
    bytes: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    unix_identity: [u64; 7],
    #[cfg(not(unix))]
    created: std::time::SystemTime,
}

impl SnapshotFileIdentity {
    fn changed_field(&self, current: &Self) -> Option<&'static str> {
        if self.bytes != current.bytes {
            return Some("bytes");
        }
        #[cfg(unix)]
        for (index, field) in [
            "device",
            "inode",
            "uid",
            "mode",
            "ctime",
            "ctime_nsec",
            "gid",
        ]
        .iter()
        .enumerate()
        {
            if self.unix_identity[index] != current.unix_identity[index] {
                return Some(field);
            }
        }
        if self.modified != current.modified {
            return Some("modified");
        }
        #[cfg(not(unix))]
        if self.created != current.created {
            return Some("created");
        }
        None
    }

    fn read(path: &Path) -> Result<Self, TransferError> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(TransferError::Blocked(
                "qualified snapshot file binding changed".into(),
            ));
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            bytes: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            unix_identity: [
                metadata.dev(),
                metadata.ino(),
                metadata.uid().into(),
                metadata.mode().into(),
                metadata.ctime() as u64,
                metadata.ctime_nsec() as u64,
                metadata.gid().into(),
            ],
            #[cfg(not(unix))]
            created: metadata.created()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapshotFiles {
    database: SnapshotFileIdentity,
    sidecars: Vec<Option<SnapshotFileIdentity>>,
}

impl SnapshotFiles {
    fn changed_binding(&self, current: &Self) -> Option<String> {
        if let Some(field) = self.database.changed_field(&current.database) {
            return Some(format!("database_{field}"));
        }
        for (index, name) in ["wal", "journal"].iter().enumerate() {
            match (&self.sidecars[index], &current.sidecars[index]) {
                (Some(before), Some(after)) => {
                    if let Some(field) = before.changed_field(after) {
                        return Some(format!("{name}_{field}"));
                    }
                }
                (None, None) => {}
                _ => return Some(format!("{name}_presence")),
            }
        }
        None
    }

    fn read(path: &Path) -> Result<Self, TransferError> {
        let mut sidecars = Vec::new();
        for suffix in ["-wal", "-journal"] {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(suffix);
            match SnapshotFileIdentity::read(Path::new(&sidecar)) {
                Ok(identity) => sidecars.push(Some(identity)),
                Err(TransferError::Io(_)) if !Path::new(&sidecar).try_exists()? => {
                    sidecars.push(None)
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Self {
            database: SnapshotFileIdentity::read(path)?,
            sidecars,
        })
    }
}

impl QualifiedSourceSnapshot {
    pub fn receipt(&self) -> &QualifiedSnapshotReceipt {
        &self.receipt
    }
    pub fn inventory(&self) -> HostOpenCodeInventory {
        let mut inventory = HostOpenCodeInventory::new(self.path.clone());
        inventory.workspace_mounts = self.workspace_mounts.clone();
        inventory.trusted_directory_mounts = self.trusted_directory_mounts.clone();
        inventory.qualified_snapshot = Some(Box::new(self.clone()));
        inventory
    }
}

pub fn source_graph_fingerprint(
    manifest: &OpenCodeTransferManifest,
) -> Result<String, TransferError> {
    if manifest.version >= 2 {
        return digest_serializable(&(
            &manifest.provider_schema,
            &manifest.source_schema_fingerprint,
            &manifest.migration_journal_fingerprint,
            &manifest.root_session_id,
            manifest.row_count,
            manifest.asset_count(),
            &manifest.payload_sha256,
        ));
    }
    digest_serializable(&(
        &manifest.provider_schema,
        &manifest.source_schema_fingerprint,
        &manifest.migration_journal_fingerprint,
        &manifest.rows,
        &manifest.assets,
        &manifest.native_cleanup_baselines,
        &manifest.saved_snapshots,
    ))
}

pub fn capture_qualified_snapshot(
    inventory: &HostOpenCodeInventory,
    roots: &[String],
    snapshot_file: &Path,
    options: ExportOptions,
) -> Result<QualifiedSourceSnapshot, TransferError> {
    options.run_phase("capture", None, "roots", |phase| {
        let qualified =
            capture_qualified_snapshot_inner(inventory, roots, snapshot_file, options.clone())?;
        phase.progress(roots.len() as u64, Some(roots.len() as u64));
        Ok(qualified)
    })
}

fn capture_qualified_snapshot_inner(
    inventory: &HostOpenCodeInventory,
    roots: &[String],
    snapshot_file: &Path,
    options: ExportOptions,
) -> Result<QualifiedSourceSnapshot, TransferError> {
    if roots.is_empty()
        || roots.len() > MAX_SOURCE_CANDIDATES
        || roots.iter().collect::<BTreeSet<_>>().len() != roots.len()
        || !snapshot_file.is_absolute()
        || snapshot_file.exists()
    {
        return Err(TransferError::Blocked(
            "exact distinct roots and a fresh absolute private snapshot required".into(),
        ));
    }
    let source_path = options.run_phase("source_resolution", None, "roots", |phase| {
        let source_path = resolve_exact_source(inventory, &roots[0])?.canonicalize()?;
        for (index, root) in roots.iter().enumerate() {
            if resolve_exact_source(inventory, root)?.canonicalize()? != source_path {
                return Err(TransferError::Blocked(
                    "selected roots do not share one independently resolved source".into(),
                ));
            }
            phase.progress(index as u64 + 1, Some(roots.len() as u64));
        }
        Ok(source_path)
    })?;
    let source = open_source_read_only(&source_path)?;
    let mut private = OpenOptions::new();
    private.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        private.mode(0o600);
    }
    private.open(snapshot_file)?.sync_all()?;
    create_observed_online_backup(&source, snapshot_file, &options)?;
    let snapshot = Connection::open_with_flags(
        snapshot_file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let (source_schema_fingerprint, migration_journal_fingerprint) =
        options.run_phase("schema", None, "tables", |_| {
            validate_known_schema(&snapshot)?;
            Ok((
                schema_fingerprint(&snapshot)?,
                migration_fingerprint(&snapshot)?,
            ))
        })?;
    let bytes = fs::metadata(snapshot_file)?.len();
    let mut qualified = QualifiedSourceSnapshot {
        path: snapshot_file.canonicalize()?,
        files: SnapshotFiles::read(snapshot_file)?,
        receipt: QualifiedSnapshotReceipt {
            source_store_id: digest(source_path.to_string_lossy().as_bytes()),
            canonical_source_database: source_path.clone(),
            snapshot_sha256: hash_file_observed(snapshot_file, &options)?,
            snapshot_bytes: bytes,
            source_schema_fingerprint,
            migration_journal_fingerprint,
            roots: roots
                .iter()
                .map(|root| QualifiedSnapshotRoot {
                    root_session_id: root.clone(),
                    graph_fingerprint: String::new(),
                })
                .collect(),
        },
        tool_output_directory: inventory.tool_output_directory(&source_path),
        workspace_mounts: inventory.workspace_mounts.clone(),
        trusted_directory_mounts: inventory.trusted_directory_mounts.clone(),
        _capture_guard: None,
    };
    drop(snapshot);
    for (index, root) in roots.iter().enumerate() {
        let exported = export_exact_session(&qualified.inventory(), root, options.clone())?;
        qualified.receipt.roots[index].graph_fingerprint =
            source_graph_fingerprint(exported.manifest())?;
    }
    qualified
        .receipt
        .roots
        .sort_by(|left, right| left.root_session_id.cmp(&right.root_session_id));
    Ok(qualified)
}

/// Keep one consistent capture alive for a complete read-only batch. The
/// existing extraction-owner recovery handles interrupted captures as well.
pub fn capture_qualified_batch(
    inventory: &HostOpenCodeInventory,
    roots: &[String],
    options: ExportOptions,
) -> Result<QualifiedSourceSnapshot, TransferError> {
    let parent = prepare_extraction_root(&options.extraction_root)?;
    recover_interrupted_extractions(&parent)?;
    let directory = Builder::new()
        .prefix(&format!("{EXTRACT_DIR_PREFIX}{}-", std::process::id()))
        .tempdir_in(&parent)?;
    write_owner_pid(directory.path())?;
    let mut qualified = capture_qualified_snapshot(
        inventory,
        roots,
        &directory.path().join("snapshot.sqlite"),
        options,
    )?;
    qualified._capture_guard = Some(std::sync::Arc::new(directory));
    Ok(qualified)
}

/// An existing private copy gets original authority only by matching an
/// independently captured current source's complete selected-root closure.
pub fn qualify_existing_snapshot(
    inventory: &HostOpenCodeInventory,
    roots: &[String],
    snapshot_file: &Path,
    options: ExportOptions,
) -> Result<QualifiedSourceSnapshot, TransferError> {
    let parent = prepare_extraction_root(&options.extraction_root)?;
    let current = tempfile::tempdir_in(parent)?;
    let trusted = capture_qualified_snapshot(
        inventory,
        roots,
        &current.path().join("current.sqlite"),
        options.clone(),
    )?;
    let metadata = fs::symlink_metadata(snapshot_file)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || !snapshot_file.is_absolute()
        || snapshot_file.canonicalize()? != snapshot_file
    {
        return Err(TransferError::Blocked(
            "qualified snapshot must be an exact private regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(TransferError::Blocked(
                "snapshot ownership or privacy differs".into(),
            ));
        }
    }
    let snapshot = Connection::open_with_flags(
        snapshot_file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    validate_known_schema(&snapshot)?;
    if schema_fingerprint(&snapshot)? != trusted.receipt.source_schema_fingerprint
        || migration_fingerprint(&snapshot)? != trusted.receipt.migration_journal_fingerprint
    {
        return Err(TransferError::Blocked(
            "snapshot schema or migrations differ from the independently captured source".into(),
        ));
    }
    drop(snapshot);
    let mut qualified = trusted.clone();
    qualified.path = snapshot_file.to_path_buf();
    qualified.files = SnapshotFiles::read(snapshot_file)?;
    qualified.receipt.snapshot_bytes = metadata.len();
    qualified.receipt.snapshot_sha256 = hash_file(snapshot_file)?;
    for root in &trusted.receipt.roots {
        let exported = export_exact_session(
            &qualified.inventory(),
            &root.root_session_id,
            options.clone(),
        )?;
        if source_graph_fingerprint(exported.manifest())? != root.graph_fingerprint {
            return Err(TransferError::Blocked(
                "snapshot root closure differs from independent source authority".into(),
            ));
        }
    }
    Ok(qualified)
}

fn hash_file(path: &Path) -> Result<String, TransferError> {
    hash_file_observed(path, &ExportOptions::default())
}

fn hash_file_observed(path: &Path, options: &ExportOptions) -> Result<String, TransferError> {
    options.run_phase("hash", None, "bytes", |phase| {
        let mut file = File::open(path)?;
        let total = file.metadata()?.len();
        let mut completed = 0;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            completed += read as u64;
            phase.progress(completed, Some(total));
        }
        Ok(hex::encode(hash.finalize()))
    })
}

/// Body-free census produced only by reading the complete declared host inventory.
#[derive(Debug, Clone)]
pub struct NativeSourceInventory {
    source_store_id: String,
    root_session_id: String,
    schema_fingerprint: String,
    migration_fingerprint: String,
    inventory_fingerprint: String,
    available: bool,
}

impl NativeSourceInventory {
    pub fn source_store_id(&self) -> &str {
        &self.source_store_id
    }
    pub fn root_session_id(&self) -> &str {
        &self.root_session_id
    }
    pub fn schema_fingerprint(&self) -> &str {
        &self.schema_fingerprint
    }
    pub fn migration_fingerprint(&self) -> &str {
        &self.migration_fingerprint
    }
    pub fn inventory_fingerprint(&self) -> &str {
        &self.inventory_fingerprint
    }
    pub fn available(&self) -> bool {
        self.available
    }
}

impl HostOpenCodeInventory {
    pub fn inspect_exact_origin(
        &self,
        source_store_id: &str,
        root_session_id: &str,
    ) -> Result<NativeSourceInventory, TransferError> {
        let candidates = self.candidates()?;
        let mut census = Vec::new();
        let mut origin = None;
        let mut available = false;
        // Keep every read transaction open until the census is complete. No
        // message/part bodies, assets, or configuration are read here.
        let mut sources = Vec::new();
        for path in &candidates {
            let canonical = path.canonicalize()?;
            let store = digest(canonical.to_string_lossy().as_bytes());
            let db = open_source_read_only(&canonical)?;
            db.execute_batch("BEGIN DEFERRED")?;
            validate_known_schema(&db)?;
            let schema = schema_fingerprint(&db)?;
            let migration = migration_fingerprint(&db)?;
            let found: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id=?1)",
                [root_session_id],
                |row| row.get(0),
            )?;
            if !found && native_history_references_root(&db, root_session_id)? {
                return Err(TransferError::Blocked(
                    "native history remains without its session root".into(),
                ));
            }
            available |= found;
            if store == source_store_id {
                origin = Some((schema.clone(), migration.clone()));
            }
            census.push((store, schema, migration, found));
            sources.push(db);
        }
        if let Some(root) = &self.discovery_root {
            if Self::discover_in_data_home(root)?.candidates()? != candidates {
                return Err(TransferError::Blocked(
                    "source inventory changed during inspection".into(),
                ));
            }
        }
        // A disappeared origin must not be silently omitted by discovery.
        let (schema_fingerprint, migration_fingerprint) = origin.ok_or_else(|| {
            TransferError::Blocked("original source store is not in the readable inventory".into())
        })?;
        let inventory_fingerprint = digest(
            &serde_json::to_vec(&(root_session_id, census))
                .map_err(|e| TransferError::Serialization(e.to_string()))?,
        );
        Ok(NativeSourceInventory {
            source_store_id: source_store_id.into(),
            root_session_id: root_session_id.into(),
            schema_fingerprint,
            migration_fingerprint,
            inventory_fingerprint,
            available,
        })
    }
}

fn native_history_references_root(db: &Connection, root: &str) -> Result<bool, TransferError> {
    // Only inspect identity columns. A partial store is unresolved even when
    // the root row itself has disappeared; retained events may still recover it.
    for (table, column) in [
        ("session", "parent_id"),
        ("event_sequence", "aggregate_id"),
        ("event", "aggregate_id"),
        ("message", "session_id"),
        ("part", "session_id"),
        ("session_context_epoch", "session_id"),
        ("session_input", "session_id"),
        ("session_message", "session_id"),
        ("todo", "session_id"),
        ("session_share", "session_id"),
    ] {
        if db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1)"),
            [root],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(true);
        }
    }
    Ok(false)
}

// Fixed-size, body-free operation attempts and elapsed microseconds, including
// partial failed operations. These describe reader cost only;
// they are not storage authority, provider evidence or restoration readiness.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReaderCosts {
    pub fresh_inspections: u64,
    pub fresh_inspection_us: u64,
    pub native_queries: u64,
    pub native_query_us: u64,
    pub native_spawns: u64,
    pub native_spawn_us: u64,
    pub settlement_us: u64,
    pub packed_store_high_water: u64,
    pub aggregate_fallbacks: u64,
    pub aggregate_rejections: u64,
    // Inclusive operation totals overlap: compression is inside representation,
    // and reads/representation are inside saved reference qualification/assembly.
    // Interrupted operations contribute only after returning.
    pub loose_lookup_us: u64,
    pub loose_lookup_attempts: u64,
    pub representation_us: u64,
    pub representation_hits: u64,
    pub representation_misses: u64,
    pub compression_us: u64,
    pub saved_reference_us: u64,
    pub saved_reference_attempts: u64,
    pub workspace_git_us: u64,
    pub workspace_git_attempts: u64,
    pub workspace_git_successes: u64,
    pub workspace_git_refusals: u64,
    pub workspace_git_command_us: u64,
    pub workspace_git_command_starts: u64,
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u64::MAX as u128) as u64
}

/// Body-free diagnostics from the operation currently reading a source. Counts
/// describe work performed, not authority, completeness, or recovery readiness.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTransferProgress {
    pub severity: &'static str,
    pub phase: &'static str,
    pub state: &'static str,
    pub root_session_id: Option<String>,
    pub elapsed_ms: u64,
    pub count_unit: &'static str,
    pub completed_count: u64,
    pub total_count: Option<u64>,
    pub error_class: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_costs: Option<SourceReaderCosts>,
}

type SourceProgressObserver = std::sync::Arc<dyn Fn(SourceTransferProgress) + Send + Sync>;

#[derive(Clone)]
pub struct ExportOptions {
    extraction_root: PathBuf,
    progress_observer: Option<SourceProgressObserver>,
}

impl std::fmt::Debug for ExportOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExportOptions")
            .field("extraction_root", &self.extraction_root)
            .field("has_progress_observer", &self.progress_observer.is_some())
            .finish()
    }
}

impl ExportOptions {
    pub fn new(extraction_root: PathBuf) -> Self {
        Self {
            extraction_root,
            progress_observer: None,
        }
    }

    /// Attach the owning caller's structured log sink. It receives only safe
    /// phase metadata, never nested errors, paths, object IDs, or content.
    pub fn with_progress_observer(
        mut self,
        observer: impl Fn(SourceTransferProgress) + Send + Sync + 'static,
    ) -> Self {
        self.progress_observer = Some(std::sync::Arc::new(observer));
        self
    }

    fn phase(&self, phase: &'static str, root: Option<&str>, unit: &'static str) -> SourcePhase {
        SourcePhase::new(self.progress_observer.clone(), phase, root, unit)
    }

    fn run_phase<T>(
        &self,
        name: &'static str,
        root: Option<&str>,
        unit: &'static str,
        run: impl FnOnce(&mut SourcePhase) -> Result<T, TransferError>,
    ) -> Result<T, TransferError> {
        let mut phase = self.phase(name, root, unit);
        let result = run(&mut phase);
        phase.finish(result.as_ref().err());
        result
    }
}

// One phase emits lifecycle events and at most one progress event per five
// seconds after its first update. Updates retain exact final counts even when
// they are not logged. No object/reference catalog is kept for diagnostics.
struct SourcePhase {
    observer: Option<SourceProgressObserver>,
    started: Instant,
    last_progress: Option<Instant>,
    event: SourceTransferProgress,
}

impl SourcePhase {
    fn new(
        observer: Option<SourceProgressObserver>,
        phase: &'static str,
        root: Option<&str>,
        unit: &'static str,
    ) -> Self {
        let mut phase = Self {
            observer,
            started: Instant::now(),
            last_progress: None,
            event: SourceTransferProgress {
                severity: "info",
                phase,
                state: "started",
                root_session_id: root.map(str::to_string),
                elapsed_ms: 0,
                count_unit: unit,
                completed_count: 0,
                total_count: None,
                error_class: None,
                reader_costs: (phase == "saved_objects").then(SourceReaderCosts::default),
            },
        };
        phase.emit();
        phase
    }

    fn emit(&mut self) {
        self.event.elapsed_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if let Some(observer) = &self.observer {
            observer(self.event.clone());
        } else {
            let event = &self.event;
            if event.severity == "error" {
                tracing::error!(
                    severity = event.severity,
                    phase = event.phase,
                    state = event.state,
                    root_session_id = event.root_session_id.as_deref(),
                    elapsed_ms = event.elapsed_ms,
                    count_unit = event.count_unit,
                    completed_count = event.completed_count,
                    total_count = event.total_count,
                    error_class = event.error_class,
                    fresh_inspections = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.fresh_inspections),
                    fresh_inspection_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.fresh_inspection_us),
                    native_queries = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_queries),
                    native_query_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_query_us),
                    native_spawns = event.reader_costs.as_ref().map(|costs| costs.native_spawns),
                    native_spawn_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_spawn_us),
                    settlement_us = event.reader_costs.as_ref().map(|costs| costs.settlement_us),
                    packed_store_high_water = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.packed_store_high_water),
                    aggregate_fallbacks = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.aggregate_fallbacks),
                    aggregate_rejections = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.aggregate_rejections),
                    loose_lookup_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.loose_lookup_us),
                    loose_lookup_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.loose_lookup_attempts),
                    representation_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_us),
                    representation_hits = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_hits),
                    representation_misses = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_misses),
                    compression_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.compression_us),
                    saved_reference_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.saved_reference_us),
                    saved_reference_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.saved_reference_attempts),
                    workspace_git_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_us),
                    workspace_git_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_attempts),
                    workspace_git_successes = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_successes),
                    workspace_git_refusals = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_refusals),
                    workspace_git_command_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_command_us),
                    workspace_git_command_starts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_command_starts),
                    "opencode.source.phase"
                );
            } else {
                tracing::info!(
                    severity = event.severity,
                    phase = event.phase,
                    state = event.state,
                    root_session_id = event.root_session_id.as_deref(),
                    elapsed_ms = event.elapsed_ms,
                    count_unit = event.count_unit,
                    completed_count = event.completed_count,
                    total_count = event.total_count,
                    fresh_inspections = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.fresh_inspections),
                    fresh_inspection_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.fresh_inspection_us),
                    native_queries = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_queries),
                    native_query_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_query_us),
                    native_spawns = event.reader_costs.as_ref().map(|costs| costs.native_spawns),
                    native_spawn_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.native_spawn_us),
                    settlement_us = event.reader_costs.as_ref().map(|costs| costs.settlement_us),
                    packed_store_high_water = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.packed_store_high_water),
                    aggregate_fallbacks = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.aggregate_fallbacks),
                    aggregate_rejections = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.aggregate_rejections),
                    loose_lookup_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.loose_lookup_us),
                    loose_lookup_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.loose_lookup_attempts),
                    representation_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_us),
                    representation_hits = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_hits),
                    representation_misses = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.representation_misses),
                    compression_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.compression_us),
                    saved_reference_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.saved_reference_us),
                    saved_reference_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.saved_reference_attempts),
                    workspace_git_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_us),
                    workspace_git_attempts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_attempts),
                    workspace_git_successes = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_successes),
                    workspace_git_refusals = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_refusals),
                    workspace_git_command_us = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_command_us),
                    workspace_git_command_starts = event
                        .reader_costs
                        .as_ref()
                        .map(|costs| costs.workspace_git_command_starts),
                    "opencode.source.phase"
                );
            }
        }
    }

    fn progress(&mut self, completed: u64, total: Option<u64>) {
        self.event.completed_count = completed;
        self.event.total_count = total;
        if self
            .last_progress
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(5))
        {
            self.event.state = "progress";
            self.emit();
            self.last_progress = Some(Instant::now());
        }
    }

    fn finish(&mut self, error: Option<&TransferError>) {
        self.event.state = if error.is_some() {
            "failed"
        } else {
            "completed"
        };
        self.event.severity = if error.is_some() { "error" } else { "info" };
        self.event.error_class = error.map(|error| match error {
            TransferError::Blocked(_) => "blocked",
            TransferError::Io(_) => "io",
            TransferError::Sqlite(_) => "sqlite",
            TransferError::Serialization(_) => "serialization",
        });
        self.emit();
    }
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("freshell-opencode-transfer"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SerializedSqlValue {
    Null,
    Integer { value: i64 },
    Real { bits: String },
    Text { value: String },
    Blob { hex: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerializedRow {
    pub table: String,
    pub key: Vec<SerializedSqlValue>,
    pub values: BTreeMap<String, SerializedSqlValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowDigest {
    pub table: String,
    pub key: Vec<SerializedSqlValue>,
    pub sha256: String,
    /// Body-free commitments to individual columns let later recovery accept
    /// a typed provider transition while proving immutable fields remained.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub column_sha256: BTreeMap<String, String>,
    /// Hashes of JSON nodes in JSON-valued text columns. Values stay in the
    /// native DB; these paths allow a verifier to permit only typed fields.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub json_node_sha256: BTreeMap<String, String>,
    /// Provider event cursor captured for sequence-owning baseline rows.
    /// This is bounded, non-body metadata used to validate contiguous later
    /// transitions without retaining event payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_cursor: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenCodeTransferManifest {
    pub version: u32,
    pub provider_schema: String,
    pub root_session_id: String,
    pub source_store_id: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub sqlite_version: String,
    pub row_count: usize,
    #[serde(default)]
    pub asset_count: usize,
    #[serde(default)]
    pub saved_snapshot_summary: SavedSnapshotSummary,
    // Legacy metadata remains readable. Growing metadata belongs only in the
    // checksummed bulk payload, never in launch/control frames.
    #[serde(default, skip_serializing)]
    pub rows: Vec<RowDigest>,
    #[serde(default, skip_serializing)]
    pub assets: Vec<SerializedAssetMetadata>,
    /// Body-free native ordering and saved boundary evidence. Older manifests
    /// omit it and cannot authorize removal of imported messages or parts.
    #[serde(default, skip_serializing)]
    pub native_cleanup_baselines: Vec<NativeCleanupBaseline>,
    /// Exact saved references remain history even when their undo object is
    /// unavailable in the qualified retained stores.
    #[serde(default, skip_serializing)]
    pub saved_snapshots: Vec<SavedSnapshotReference>,
    pub payload_bytes: u64,
    pub payload_sha256: String,
    pub generation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedSnapshotAvailability {
    RetainedClosure,
    UnavailableInQualifiedLocations,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SavedSnapshotSummary {
    #[default]
    LegacyUnqualified,
    QualifiedReferences {
        retained_closure_count: u64,
        unavailable_reference_count: u64,
    },
}

pub fn saved_snapshot_summary(manifest: &OpenCodeTransferManifest) -> SavedSnapshotSummary {
    if manifest.version >= 2 {
        return manifest.saved_snapshot_summary.clone();
    }
    if manifest.native_cleanup_baselines.is_empty() {
        return SavedSnapshotSummary::LegacyUnqualified;
    }
    SavedSnapshotSummary::QualifiedReferences {
        retained_closure_count: manifest
            .saved_snapshots
            .iter()
            .filter(|reference| {
                reference.availability == SavedSnapshotAvailability::RetainedClosure
            })
            .count() as u64,
        unavailable_reference_count: manifest
            .saved_snapshots
            .iter()
            .filter(|reference| {
                reference.availability == SavedSnapshotAvailability::UnavailableInQualifiedLocations
            })
            .count() as u64,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotObjectMetadata {
    pub object_id: String,
    pub compressed_bytes: u64,
    pub compressed_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedSnapshotReference {
    pub session_id: String,
    pub project_id: String,
    pub worktree_sha1: String,
    pub tree: String,
    pub availability: SavedSnapshotAvailability,
    pub objects: Vec<SnapshotObjectMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedSnapshotObject {
    pub project_id: String,
    pub worktree_sha1: String,
    pub object_id: String,
    pub compressed_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeRevertBoundary {
    pub message_id: String,
    pub part_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeMessageBaseline {
    pub message_id: String,
    pub time_created: SerializedSqlValue,
    pub part_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeCleanupBaseline {
    pub session_id: String,
    pub revert: Option<NativeRevertBoundary>,
    pub messages: Vec<NativeMessageBaseline>,
}

/// The exact DDL and migration IDs qualified for the supported OpenCode
/// destination. Consumers must not infer a target schema from arbitrary
/// source journal rows.
pub fn pinned_destination_schema_sql() -> &'static str {
    PINNED_SCHEMA_SQL
}

pub fn pinned_destination_migration_ids() -> &'static [&'static str] {
    PINNED_MIGRATIONS
}

pub fn pinned_destination_data_migration_ids() -> &'static [&'static str] {
    PINNED_DATA_MIGRATIONS
}

pub fn pinned_destination_schema_fingerprint() -> Result<String, TransferError> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(PINNED_SCHEMA_SQL)?;
    schema_fingerprint(&connection)
}

/// Recheck the non-payload references described by an exported manifest in
/// the exact managed workspace mount. This is used by the installed-store
/// reader after import, independently of the source-side export check.
pub fn verify_asset_references(
    assets: &[SerializedAssetMetadata],
    rows: &[SerializedRow],
    workspace_root: &Path,
) -> Result<(), TransferError> {
    let workspace_mounts = resolve_workspace_mounts(rows, &[], &[workspace_root.to_path_buf()])?;
    for asset in assets {
        match asset.kind.as_str() {
            "workspace_path_reference" => {
                let mut matched = false;
                for session in rows.iter().filter(|row| row.table == "session") {
                    let session_id = required_text(session, "id")?;
                    let Some(mount) = workspace_mounts.get(&session_id) else {
                        continue;
                    };
                    let relative = checked_relative_path(&asset.source_relative_path)?;
                    let source = mount.canonical_root.join(relative);
                    let actual = AssetResolver::new(PathBuf::new(), &workspace_mounts)
                        .verify_workspace_file(&source, &session_id)?;
                    if &actual == asset {
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    return Err(TransferError::Blocked(
                        "workspace asset does not match the installed workspace contents".into(),
                    ));
                }
            }
            "git_tree_reference" => {
                let tree = asset
                    .target_relative_path
                    .rsplit(':')
                    .next()
                    .filter(|tree| tree.len() == 40 || tree.len() == 64)
                    .ok_or_else(|| {
                        TransferError::Blocked("Git asset does not identify a tree".into())
                    })?;
                let mut matched = false;
                for mount in workspace_mounts.values() {
                    let identity_bytes = serde_json::to_vec(&mount.identity)
                        .map_err(|error| TransferError::Serialization(error.to_string()))?;
                    let source_identity = format!(
                        "workspace:{}:{}",
                        digest(&identity_bytes),
                        inspect_git_tree(&mount.canonical_root, tree)?.identity
                    );
                    let inspection = inspect_git_tree(&mount.canonical_root, tree)?;
                    let actual = SerializedAssetMetadata {
                        kind: "git_tree_reference".into(),
                        source_relative_path: source_identity.clone(),
                        target_relative_path: source_identity,
                        size_bytes: inspection.closure_bytes,
                        sha256: inspection.closure_sha256,
                    };
                    if &actual == asset {
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    return Err(TransferError::Blocked(
                        "Git asset does not match the installed workspace object store".into(),
                    ));
                }
            }
            _ => {
                return Err(TransferError::Blocked(
                    "manifest contains an unsupported asset reference".into(),
                ));
            }
        }
    }
    Ok(())
}

fn checked_relative_path(path: &str) -> Result<&Path, TransferError> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(TransferError::Blocked(
            "asset path is not a safe workspace-relative path".into(),
        ));
    }
    Ok(relative)
}

impl OpenCodeTransferManifest {
    pub fn asset_count(&self) -> usize {
        if self.version >= 2 {
            self.asset_count
        } else {
            self.assets.len()
        }
    }
    pub fn row_count(&self) -> usize {
        self.row_count
    }

    pub fn row_digests(&self) -> &[RowDigest] {
        &self.rows
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerializedAssetMetadata {
    pub kind: String,
    pub source_relative_path: String,
    pub target_relative_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// A completed exact-session payload and its immutable manifest.
pub struct OpenCodeNativeSnapshot {
    manifest: OpenCodeTransferManifest,
    payload_path: PathBuf,
    _extraction: TempDir,
}

impl OpenCodeNativeSnapshot {
    pub fn manifest(&self) -> &OpenCodeTransferManifest {
        &self.manifest
    }

    pub fn open_payload(&self) -> Result<File, TransferError> {
        File::open(&self.payload_path).map_err(Into::into)
    }

    /// Open a content-addressed asset staged into this exact-session bundle.
    /// Workspace and Git references are verified in place and have no staged
    /// file to open.
    pub fn open_asset(&self, target_relative_path: &str) -> Result<File, TransferError> {
        let relative = Path::new(target_relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(TransferError::Blocked(
                "asset path is not a bundle-relative path".into(),
            ));
        }
        let asset_path = self._extraction.path().join(relative);
        let metadata = fs::symlink_metadata(&asset_path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(TransferError::Blocked(
                "staged asset is not a regular file".into(),
            ));
        }
        File::open(asset_path).map_err(Into::into)
    }
}

/// Export one exact root and its recursive descendants into a new bundle.
/// The only source path is derived from trusted host inventory, never a
/// remote request. Any incomplete or ambiguous condition returns `Blocked`.
pub fn export_exact_session(
    inventory: &HostOpenCodeInventory,
    root_session_id: &str,
    options: ExportOptions,
) -> Result<OpenCodeNativeSnapshot, TransferError> {
    options.run_phase("root_export", Some(root_session_id), "roots", |phase| {
        let exported =
            export_exact_session_inner(inventory, root_session_id, options.clone(), |path| {
                File::create(path)
            })?;
        phase.progress(1, Some(1));
        Ok(exported)
    })
}

fn export_exact_session_inner<W: Write>(
    inventory: &HostOpenCodeInventory,
    root_session_id: &str,
    options: ExportOptions,
    create_payload_writer: impl FnOnce(&Path) -> io::Result<W>,
) -> Result<OpenCodeNativeSnapshot, TransferError> {
    if root_session_id.is_empty() || root_session_id.len() > 256 {
        return Err(TransferError::Blocked(
            "native session ID is empty or over its bound".into(),
        ));
    }

    let source_path = options.run_phase(
        "source_resolution",
        Some(root_session_id),
        "roots",
        |phase| {
            let path = resolve_exact_source(inventory, root_session_id)?;
            phase.progress(1, Some(1));
            Ok(path)
        },
    )?;
    if let Some(qualified) = &inventory.qualified_snapshot {
        let changed = if source_path.canonicalize()? != qualified.path {
            Some("path".into())
        } else if fs::metadata(&qualified.path)?.len() != qualified.receipt.snapshot_bytes {
            Some("bytes".into())
        } else if let Some(binding) = qualified
            .files
            .changed_binding(&SnapshotFiles::read(&qualified.path)?)
        {
            Some(binding)
        } else if !qualified
            .receipt
            .roots
            .iter()
            .any(|root| root.root_session_id == root_session_id)
        {
            Some("selected_root".into())
        } else {
            None
        };
        if let Some(changed) = changed {
            return Err(TransferError::Blocked(format!(
                "qualified snapshot changed: {changed}"
            )));
        }
    }
    let source = open_source_read_only(&source_path)?;
    let extraction_root = prepare_extraction_root(&options.extraction_root)?;
    recover_interrupted_extractions(&extraction_root)?;
    let extraction = Builder::new()
        .prefix(&format!("{EXTRACT_DIR_PREFIX}{}-", std::process::id()))
        .tempdir_in(&extraction_root)?;
    write_owner_pid(extraction.path())?;
    // A qualified, immutable private capture already has a byte/closure fence.
    // Avoid copying the entire host store again for every selected root.
    let owns_snapshot = inventory.qualified_snapshot.is_none();
    let snapshot_path = if owns_snapshot {
        extraction.path().join("snapshot.sqlite")
    } else {
        source_path.clone()
    };
    if owns_snapshot {
        create_observed_online_backup(&source, &snapshot_path, &options)?;
    }
    if let Some(qualified) = &inventory.qualified_snapshot {
        if SnapshotFiles::read(&qualified.path)? != qualified.files {
            return Err(TransferError::Blocked(
                "qualified source snapshot changed during export".into(),
            ));
        }
    }

    let result: Result<(PathBuf, OpenCodeTransferManifest), TransferError> = (|| {
        let snapshot = Connection::open_with_flags(
            &snapshot_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        snapshot.busy_timeout(Duration::from_secs(5))?;
        snapshot.execute_batch("BEGIN DEFERRED")?;
        let (source_schema_fingerprint, migration_journal_fingerprint) =
            options.run_phase("schema", Some(root_session_id), "tables", |_| {
                validate_known_schema(&snapshot)?;
                Ok((
                    schema_fingerprint(&snapshot)?,
                    migration_fingerprint(&snapshot)?,
                ))
            })?;
        let sqlite_version = snapshot.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let mut rows =
            options.run_phase("row_closure", Some(root_session_id), "rows", |phase| {
                let rows = collect_exact_closure(&snapshot, root_session_id)?;
                phase.progress(rows.len() as u64, Some(rows.len() as u64));
                Ok(rows)
            })?;
        let workspace_mounts = resolve_workspace_mounts(
            &rows,
            &inventory.workspace_mounts,
            &inventory.trusted_directory_mounts,
        )?;
        let mut asset_resolver = AssetResolver::new(
            inventory.tool_output_directory(&source_path),
            &workspace_mounts,
        );
        asset_resolver.snapshot_data_home = inventory
            .tool_output_directory(&source_path)
            .parent()
            .map(Path::to_path_buf);
        asset_resolver.snapshot_projects = rows
            .iter()
            .filter(|row| row.table == "session")
            .map(|row| Ok((required_text(row, "id")?, required_text(row, "project_id")?)))
            .collect::<Result<HashMap<_, _>, TransferError>>()?;
        asset_resolver.source_progress =
            Some(options.phase("saved_objects", Some(root_session_id), "object_reads"));
        asset_resolver.resolve_rows(&mut rows)?;
        let assets = asset_resolver.metadata();
        let saved_snapshots = asset_resolver
            .saved_snapshots
            .values()
            .cloned()
            .collect::<Vec<_>>();
        // A repeated reference can become unavailable after an earlier capture.
        // Emit only the final retained union, including objects shared by trees
        // that remain available.
        let retained_snapshot_objects = saved_snapshots
            .iter()
            .flat_map(|reference| {
                reference.objects.iter().map(|object| {
                    (
                        &reference.project_id,
                        &reference.worktree_sha1,
                        &object.object_id,
                    )
                })
            })
            .collect::<BTreeSet<_>>();
        let snapshot_objects = asset_resolver
            .snapshot_objects
            .iter()
            .filter(|((project_id, worktree_sha1, object_id), _)| {
                retained_snapshot_objects.contains(&(project_id, worktree_sha1, object_id))
            })
            .map(
                |((project_id, worktree_sha1, object_id), output)| SerializedSnapshotObject {
                    project_id: project_id.clone(),
                    worktree_sha1: worktree_sha1.clone(),
                    object_id: object_id.clone(),
                    compressed_hex: output.compressed_hex.as_ref().clone(),
                },
            )
            .collect::<Vec<_>>();
        let payload_path = extraction.path().join("bundle.json");
        let (payload_bytes, payload_sha256) =
            options.run_phase("serialize", Some(root_session_id), "bytes", |phase| {
                let file = create_payload_writer(&payload_path)?;
                let (payload_bytes, payload_sha256) = serialize_transfer_payload(
                    file,
                    &TransferPayload {
                        version: EXPORT_VERSION,
                        root_session_id,
                        rows: &rows,
                        assets: &assets,
                        saved_snapshots: &saved_snapshots,
                        snapshot_objects: &snapshot_objects,
                    },
                    MAX_BUNDLE_BYTES,
                )?;
                phase.progress(payload_bytes, Some(payload_bytes));
                Ok((payload_bytes, payload_sha256))
            })?;
        let source_store_id = match &inventory.qualified_snapshot {
            Some(qualified) => qualified.receipt.source_store_id.clone(),
            None => digest(source_path.canonicalize()?.to_string_lossy().as_bytes()),
        };
        let mut manifest = OpenCodeTransferManifest {
            version: EXPORT_VERSION,
            provider_schema: OPENCODE_SCHEMA_VERSION.to_string(),
            root_session_id: root_session_id.to_string(),
            source_store_id,
            source_schema_fingerprint,
            migration_journal_fingerprint,
            sqlite_version,
            row_count: rows.len(),
            asset_count: assets.len(),
            saved_snapshot_summary: SavedSnapshotSummary::QualifiedReferences {
                retained_closure_count: saved_snapshots
                    .iter()
                    .filter(|reference| {
                        reference.availability == SavedSnapshotAvailability::RetainedClosure
                    })
                    .count() as u64,
                unavailable_reference_count: saved_snapshots
                    .iter()
                    .filter(|reference| {
                        reference.availability
                            == SavedSnapshotAvailability::UnavailableInQualifiedLocations
                    })
                    .count() as u64,
            },
            rows: Vec::new(),
            assets,
            native_cleanup_baselines: Vec::new(),
            saved_snapshots,
            payload_bytes,
            payload_sha256,
            generation: String::new(),
        };
        let manifest_bytes = serde_json::to_vec(&manifest)
            .map_err(|error| TransferError::Serialization(error.to_string()))?;
        manifest.generation = digest(&manifest_bytes);
        if let Some(qualified) = &inventory.qualified_snapshot {
            let root = qualified
                .receipt
                .roots
                .iter()
                .find(|root| root.root_session_id == root_session_id)
                .ok_or_else(|| {
                    TransferError::Blocked("export root is outside the qualified snapshot".into())
                })?;
            if manifest.source_schema_fingerprint != qualified.receipt.source_schema_fingerprint
                || manifest.migration_journal_fingerprint
                    != qualified.receipt.migration_journal_fingerprint
                || (!root.graph_fingerprint.is_empty()
                    && source_graph_fingerprint(&manifest)? != root.graph_fingerprint)
            {
                return Err(TransferError::Blocked(
                    "qualified snapshot root closure or schema changed".into(),
                ));
            }
        }
        Ok((payload_path, manifest))
    })();

    // The backup and its SQLite sidecars are extraction-only. They are
    // removed before an export can be returned or published to another host.
    if owns_snapshot {
        remove_snapshot_files(&snapshot_path)?;
    }
    if let Some(qualified) = &inventory.qualified_snapshot {
        if SnapshotFiles::read(&qualified.path)? != qualified.files {
            return Err(TransferError::Blocked(
                "qualified snapshot changed while its complete root was serialized".into(),
            ));
        }
    }
    let (payload_path, manifest) = result?;
    Ok(OpenCodeNativeSnapshot {
        manifest,
        payload_path,
        _extraction: extraction,
    })
}

#[derive(Serialize)]
struct TransferPayload<'a> {
    version: u32,
    root_session_id: &'a str,
    rows: &'a [SerializedRow],
    assets: &'a [SerializedAssetMetadata],
    saved_snapshots: &'a [SavedSnapshotReference],
    snapshot_objects: &'a [SerializedSnapshotObject],
}

fn serialize_transfer_payload(
    inner: impl Write,
    payload: &TransferPayload<'_>,
    limit: u64,
) -> Result<(u64, String), TransferError> {
    let mut hasher = Sha256::new();
    let buffered = BufWriter::with_capacity(PAYLOAD_WRITE_BUFFER_BYTES, inner);
    let mut writer = HashingWriter::new(buffered, &mut hasher, limit);
    let serialized = serde_json::to_writer(&mut writer, payload);
    if writer.limit_exceeded {
        return Err(TransferError::Blocked(
            "exact-session bundle exceeds 8 GiB".into(),
        ));
    }
    serialized.map_err(|error| TransferError::Serialization(error.to_string()))?;
    writer.flush()?;
    let payload_bytes = writer.bytes;
    drop(writer);
    Ok((payload_bytes, hex::encode(hasher.finalize())))
}

struct HashingWriter<'a, W> {
    inner: W,
    hasher: &'a mut Sha256,
    bytes: u64,
    limit: u64,
    limit_exceeded: bool,
}

impl<'a, W> HashingWriter<'a, W> {
    fn new(inner: W, hasher: &'a mut Sha256, limit: u64) -> Self {
        Self {
            inner,
            hasher,
            bytes: 0,
            limit,
            limit_exceeded: false,
        }
    }
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let bytes = &bytes[..bytes.len().min(256 * 1024)];
        let Some(next) = self.bytes.checked_add(bytes.len() as u64) else {
            self.limit_exceeded = true;
            return Err(io::Error::other("bundle size overflow"));
        };
        if next > self.limit {
            self.limit_exceeded = true;
            return Err(io::Error::other("exact-session bundle exceeds 8 GiB"));
        }
        let written = self.inner.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn resolve_workspace_mounts(
    rows: &[SerializedRow],
    mappings: &[WorkspaceMountMapping],
    trusted_directory_mounts: &[PathBuf],
) -> Result<HashMap<String, ResolvedWorkspaceMount>, TransferError> {
    let mut resolved = HashMap::new();
    for session in rows.iter().filter(|row| row.table == "session") {
        let session_id = required_text(session, "id")?;
        let identity = WorkspaceIdentity {
            project_id: required_text(session, "project_id")?,
            workspace_id: value_text(session, "workspace_id")?,
            directory: required_text(session, "directory")?,
        };
        let matches = mappings
            .iter()
            .filter(|mapping| mapping.identity == identity);
        let explicit_matches = matches.collect::<Vec<_>>();
        let mut matched_mounts = explicit_matches
            .iter()
            .map(|mapping| mapping.managed_mount.clone())
            .collect::<Vec<_>>();
        for managed_mount in trusted_directory_mounts {
            let canonical = fs::canonicalize(managed_mount).map_err(|error| {
                TransferError::Blocked(format!(
                    "trusted managed workspace mount is unavailable for session {session_id}: {error}"
                ))
            })?;
            if identity.directory == canonical.to_string_lossy() {
                matched_mounts.push(canonical);
            }
        }
        if matched_mounts.len() > 1 {
            return Err(TransferError::Blocked(format!(
                "trusted workspace mapping is ambiguous for session {session_id}"
            )));
        }
        let Some(matched_mount) = matched_mounts.into_iter().next() else {
            continue;
        };
        let canonical_root = fs::canonicalize(&matched_mount).map_err(|error| {
            TransferError::Blocked(format!(
                "trusted managed workspace mount is unavailable for session {session_id}: {error}"
            ))
        })?;
        if !fs::metadata(&canonical_root)?.is_dir() {
            return Err(TransferError::Blocked(format!(
                "trusted managed workspace mount is not a directory for session {session_id}"
            )));
        }
        resolved.insert(
            session_id,
            ResolvedWorkspaceMount {
                canonical_root,
                identity,
            },
        );
    }
    Ok(resolved)
}

fn session_id_for_reference_row(row: &SerializedRow) -> Result<String, TransferError> {
    let key = match row.table.as_str() {
        "message" | "part" | "session_message" | "session_input" | "session_context_epoch" => {
            "session_id"
        }
        "session" => "id",
        "event" => "aggregate_id",
        _ => {
            return Err(TransferError::Blocked(format!(
                "{} row has no supported session identity for JSON reference traversal",
                row.table
            )))
        }
    };
    required_text(row, key)
}

struct AssetResolver<'a> {
    tool_output_root: PathBuf,
    workspace_mounts: &'a HashMap<String, ResolvedWorkspaceMount>,
    assets: BTreeMap<String, SerializedAssetMetadata>,
    snapshot_data_home: Option<PathBuf>,
    snapshot_projects: HashMap<String, String>,
    saved_snapshots: BTreeMap<(String, String), SavedSnapshotReference>,
    snapshot_objects: BTreeMap<(String, String, String), SnapshotOutput>,
    object_representations: SnapshotRepresentations,
    packed_decoders: SnapshotPackedDecoders,
    source_progress: Option<SourcePhase>,
}

impl<'a> AssetResolver<'a> {
    fn new(
        tool_output_root: PathBuf,
        workspace_mounts: &'a HashMap<String, ResolvedWorkspaceMount>,
    ) -> Self {
        Self {
            tool_output_root,
            workspace_mounts,
            assets: BTreeMap::new(),
            snapshot_data_home: None,
            snapshot_projects: HashMap::new(),
            saved_snapshots: BTreeMap::new(),
            snapshot_objects: BTreeMap::new(),
            object_representations: SnapshotRepresentations::new(),
            packed_decoders: SnapshotPackedDecoders::default(),
            source_progress: None,
        }
    }

    fn metadata(&self) -> Vec<SerializedAssetMetadata> {
        self.assets.values().cloned().collect()
    }

    fn resolve_rows(&mut self, rows: &mut [SerializedRow]) -> Result<(), TransferError> {
        let result = self.resolve_rows_inner(rows);
        let closed = self.packed_decoders.finish();
        let result = result.and(closed);
        self.refresh_reader_costs();
        if let Some(progress) = &mut self.source_progress {
            progress.finish(result.as_ref().err());
        }
        result
    }

    fn resolve_rows_inner(&mut self, rows: &mut [SerializedRow]) -> Result<(), TransferError> {
        for row in rows {
            let columns: &[&str] = match row.table.as_str() {
                "message" | "part" | "session_message" => &["data"],
                "session_input" => &["prompt"],
                "session" => &["revert"],
                "event" => &["data"],
                "session_context_epoch" => &["snapshot"],
                _ => &[],
            };
            for column in columns {
                let session_id = session_id_for_reference_row(row)?;
                let event_kind = if row.table == "event" {
                    value_text(row, "type")?
                } else {
                    None
                };
                let nullable = row.table == "session" && *column == "revert";
                let value = match row.values.get_mut(*column) {
                    Some(SerializedSqlValue::Text { value }) => value,
                    Some(SerializedSqlValue::Null) if nullable => continue,
                    Some(SerializedSqlValue::Null) => {
                        return Err(TransferError::Blocked(format!(
                            "native {}.{} JSON data is NULL",
                            row.table, column
                        )))
                    }
                    Some(_) => {
                        return Err(TransferError::Blocked(format!(
                            "native {}.{} JSON data is not stored as text",
                            row.table, column
                        )))
                    }
                    None => {
                        return Err(TransferError::Blocked(format!(
                            "native {}.{} JSON column is missing",
                            row.table, column
                        )))
                    }
                };
                let mut decoded: serde_json::Value =
                    serde_json::from_str(value).map_err(|error| {
                        TransferError::Blocked(format!(
                            "native {}.{} data is not valid JSON: {error}",
                            row.table, column
                        ))
                    })?;
                let changed = match (row.table.as_str(), *column) {
                    ("part", "data") => self.walk_native_part(&mut decoded, &session_id)?,
                    ("session", "revert") => {
                        self.resolve_revert_reference(&decoded, &session_id)?
                    }
                    ("event", "data") => {
                        self.resolve_event_assets(&mut decoded, event_kind.as_deref(), &session_id)?
                    }
                    ("session_message", "data") | ("session_input", "prompt") => {
                        self.resolve_message_parts(&mut decoded, &session_id)?
                    }
                    ("session_context_epoch", "snapshot") => {
                        let mut changed = false;
                        if let Some(messages) = decoded
                            .get_mut("messages")
                            .and_then(serde_json::Value::as_array_mut)
                        {
                            for message in messages {
                                changed |= self.resolve_message_parts(message, &session_id)?;
                            }
                        }
                        changed
                    }
                    _ => false,
                };
                if changed {
                    *value = serde_json::to_string(&decoded)
                        .map_err(|error| TransferError::Serialization(error.to_string()))?;
                }
            }
        }
        Ok(())
    }

    fn resolve_message_parts(
        &mut self,
        value: &mut serde_json::Value,
        session_id: &str,
    ) -> Result<bool, TransferError> {
        let mut changed = false;
        if let Some(parts) = value
            .get_mut("parts")
            .and_then(serde_json::Value::as_array_mut)
        {
            for part in parts {
                changed |= self.walk_native_part(part, session_id)?;
            }
        }
        Ok(changed)
    }

    fn resolve_revert_reference(
        &mut self,
        value: &serde_json::Value,
        session_id: &str,
    ) -> Result<bool, TransferError> {
        if let Some(reference) = value.get("snapshot").or_else(|| value.get("tree")) {
            let tree = reference.as_str().ok_or_else(|| {
                TransferError::Blocked("revert snapshot reference is not a Git object ID".into())
            })?;
            // Native Snapshot.track can return empty stdout. Revert preserves
            // that value but has no Undo tree to resolve; the legacy tree alias
            // remains strict and never overrides the native snapshot field.
            if tree.is_empty() && value.get("snapshot").is_some() {
                return Ok(false);
            }
            self.record_saved_snapshot(tree, session_id)?;
        }
        Ok(false)
    }

    fn resolve_event_assets(
        &mut self,
        value: &mut serde_json::Value,
        event_kind: Option<&str>,
        session_id: &str,
    ) -> Result<bool, TransferError> {
        match event_kind {
            Some("message.part.updated" | "message.part.updated.1") => value
                .get_mut("part")
                .map(|part| self.walk_native_part(part, session_id))
                .transpose()
                .map(|changed| changed.unwrap_or(false)),
            Some(
                "session.created" | "session.created.1" | "session.updated" | "session.updated.1",
            ) => {
                if let Some(revert) = value.get("info").and_then(|info| info.get("revert")) {
                    self.resolve_revert_reference(revert, session_id)?;
                }
                Ok(false)
            }
            Some("session.next.prompt.admitted.1" | "session.next.prompted.1") => value
                .get_mut("prompt")
                .map(|prompt| self.resolve_message_parts(prompt, session_id))
                .transpose()
                .map(|changed| changed.unwrap_or(false)),
            Some("session.next.tool.success.1") => {
                let mut changed = false;
                if let Some(content) = value
                    .get_mut("content")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for part in content {
                        changed |= self.walk_native_part(part, session_id)?;
                    }
                }
                Ok(changed)
            }
            _ => Ok(false),
        }
    }

    /// Only a native FilePart URL and completed-tool attachment list grant
    /// asset authority. Tool metadata/input and FilePart.source attribution
    /// remain exact payload values; arbitrary dictionaries are never assets.
    fn walk_native_part(
        &mut self,
        value: &mut serde_json::Value,
        session_id: &str,
    ) -> Result<bool, TransferError> {
        match value {
            serde_json::Value::Object(object) => {
                let mut changed = false;
                let kind = object
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                if kind.as_deref() == Some("file") {
                    let url = object
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TransferError::Blocked("native file part has no recognized URL".into())
                        })?
                        .to_string();
                    let replacement = self.resolve_file_url(&url, session_id)?;
                    if replacement != url {
                        object.insert("url".into(), serde_json::Value::String(replacement));
                        changed = true;
                    }
                }
                if kind.as_deref() == Some("snapshot") {
                    let tree = object
                        .get("snapshot")
                        .or_else(|| object.get("tree"))
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TransferError::Blocked(
                                "snapshot part has no content-addressed Git tree ID".into(),
                            )
                        })?;
                    self.record_git_tree(tree, session_id)?;
                }
                if matches!(kind.as_deref(), Some("step-start" | "step-finish")) {
                    if let Some(reference) = object.get("snapshot") {
                        let tree = reference.as_str().ok_or_else(|| {
                            TransferError::Blocked(
                                "revert snapshot reference is not a Git object ID".into(),
                            )
                        })?;
                        // Native step producers preserve an empty track result
                        // when no tree was produced. Keep those bytes as history
                        // without inventing an object identity or Undo asset.
                        if !tree.is_empty() {
                            self.record_git_tree(tree, session_id)?;
                        }
                    }
                }
                if kind.as_deref() == Some("tool") {
                    if let Some(state) = object.get_mut("state") {
                        if let Some(output) =
                            state.get("output").and_then(serde_json::Value::as_str)
                        {
                            let mut text = output.to_string();
                            if self.rewrite_tool_output_markers(&mut text)? {
                                state["output"] = serde_json::Value::String(text);
                                changed = true;
                            }
                        }
                        if let Some(attachments) = state
                            .get_mut("attachments")
                            .and_then(serde_json::Value::as_array_mut)
                        {
                            for attachment in attachments {
                                changed |= self.walk_native_part(attachment, session_id)?;
                            }
                        }
                    }
                }
                Ok(changed)
            }
            _ => Ok(false),
        }
    }

    fn resolve_file_url(&mut self, url: &str, session_id: &str) -> Result<String, TransferError> {
        if url.starts_with("data:") {
            return Ok(url.to_string());
        }
        if !url.starts_with("file://") {
            return Err(TransferError::Blocked(
                "native file part uses an unsupported or unclassified URI".into(),
            ));
        }
        let path = decode_file_url(url)?;
        if self.is_tool_output_path(&path)? {
            let target = self.copy_tool_output(&path)?;
            return Ok(target);
        }
        let asset = self.verify_workspace_file(&path, session_id)?;
        self.assets
            .insert(asset.target_relative_path.clone(), asset);
        Ok(url.to_string())
    }

    fn rewrite_tool_output_markers(&mut self, text: &mut String) -> Result<bool, TransferError> {
        const PREFIX: &str = "... output truncated; full content saved to ";
        const SUFFIX: &str = " ...";
        let mut rewritten = text.clone();
        let mut search_from = 0;
        let mut changed = false;
        while let Some(start) = rewritten[search_from..].find(PREFIX) {
            let marker_start = search_from + start;
            let path_start = marker_start + PREFIX.len();
            let Some(end) = rewritten[path_start..].find(SUFFIX) else {
                return Err(TransferError::Blocked(
                    "tool-output reference is incomplete".into(),
                ));
            };
            let path_end = path_start + end;
            let source_path = PathBuf::from(&rewritten[path_start..path_end]);
            let target = self.copy_tool_output(&source_path)?;
            rewritten.replace_range(path_start..path_end, &target);
            search_from = path_start + target.len() + SUFFIX.len();
            changed = true;
        }
        if changed {
            *text = rewritten;
        }
        Ok(changed)
    }

    fn is_tool_output_path(&self, path: &Path) -> Result<bool, TransferError> {
        let root = match fs::canonicalize(&self.tool_output_root) {
            Ok(root) => root,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(TransferError::Blocked(format!(
                    "pinned OpenCode tool-output directory cannot be resolved: {error}"
                )))
            }
        };
        let canonical = fs::canonicalize(path).map_err(|error| {
            TransferError::Blocked(format!("native file asset is unavailable: {error}"))
        })?;
        let file_name = canonical.file_name().and_then(|value| value.to_str());
        Ok(canonical.parent() == Some(root.as_path())
            && file_name.is_some_and(|name| name.starts_with("tool_") && name.len() > 5))
    }

    fn copy_tool_output(&self, _path: &Path) -> Result<String, TransferError> {
        Err(TransferError::Blocked(
            "pinned OpenCode v1.18.21 tool-output files have no write-once retention contract and cleanup removes them after seven days".into(),
        ))
    }

    fn verify_workspace_file(
        &self,
        path: &Path,
        session_id: &str,
    ) -> Result<SerializedAssetMetadata, TransferError> {
        let workspace_mount = self.workspace_mounts.get(session_id).ok_or_else(|| {
            TransferError::Blocked(
                "native file path cannot be verified without a trusted mapping for the selected workspace".into(),
            )
        })?;
        let mount = &workspace_mount.canonical_root;
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            TransferError::Blocked(format!("workspace file reference is unavailable: {error}"))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(TransferError::Blocked(
                "workspace file reference is not a regular file".into(),
            ));
        }
        let canonical = fs::canonicalize(path).map_err(|error| {
            TransferError::Blocked(format!(
                "workspace file reference cannot be resolved: {error}"
            ))
        })?;
        let relative = canonical.strip_prefix(mount).map_err(|_| {
            TransferError::Blocked(
                "workspace file reference is outside the exact managed mount".into(),
            )
        })?;
        let relative = relative.to_string_lossy().replace('\\', "/");
        let mut file = File::open(&canonical).map_err(|error| {
            TransferError::Blocked(format!("workspace file reference cannot be read: {error}"))
        })?;
        let size_bytes = file.metadata()?.len();
        let sha256 = digest_reader(&mut file)?;
        Ok(SerializedAssetMetadata {
            kind: "workspace_path_reference".into(),
            source_relative_path: relative.clone(),
            target_relative_path: relative,
            size_bytes,
            sha256,
        })
    }

    fn record_git_tree(&mut self, tree: &str, session_id: &str) -> Result<(), TransferError> {
        self.record_saved_snapshot(tree, session_id)?;
        if self
            .saved_snapshots
            .get(&(session_id.to_string(), tree.to_string()))
            .is_some_and(|reference| {
                reference.availability == SavedSnapshotAvailability::UnavailableInQualifiedLocations
            })
        {
            // Snapshot and step parts preserve saved history just like revert
            // references. Missing undo objects do not erase that reference;
            // corrupt or incomplete retained objects already failed above.
            return Ok(());
        }
        let mount = self.workspace_mounts.get(session_id).ok_or_else(|| {
            TransferError::Blocked(
                "snapshot reference cannot be verified without a trusted mapping for the selected workspace".into(),
            )
        })?;
        // The retained native closure is sufficient authority. Add a separate
        // workspace commitment only when that repository can verify this exact
        // tree; ordinary native snapshot trees need not exist in workspace Git.
        if !mount.canonical_root.join(".git").is_dir() {
            return Ok(());
        }
        let started = Instant::now();
        let inspection = inspect_git_tree_with_costs(
            &mount.canonical_root,
            tree,
            Some(&mut self.packed_decoders.costs),
        );
        let costs = &mut self.packed_decoders.costs;
        costs.workspace_git_attempts = costs.workspace_git_attempts.saturating_add(1);
        costs.workspace_git_us = costs.workspace_git_us.saturating_add(elapsed_us(started));
        if inspection.is_ok() {
            costs.workspace_git_successes = costs.workspace_git_successes.saturating_add(1);
        } else {
            costs.workspace_git_refusals = costs.workspace_git_refusals.saturating_add(1);
        }
        self.refresh_reader_costs();
        let Ok(store) = inspection else {
            return Ok(());
        };
        let mount = self.workspace_mounts.get(session_id).unwrap();
        let identity_bytes = serde_json::to_vec(&mount.identity)
            .map_err(|error| TransferError::Serialization(error.to_string()))?;
        let source_identity = format!("workspace:{}:{}", digest(&identity_bytes), store.identity);
        let metadata = SerializedAssetMetadata {
            kind: "git_tree_reference".into(),
            source_relative_path: source_identity.clone(),
            target_relative_path: source_identity,
            size_bytes: store.closure_bytes,
            sha256: store.closure_sha256,
        };
        if let Some(existing) = self.assets.get(&metadata.target_relative_path) {
            if existing == &metadata {
                return Ok(());
            }
            return Err(TransferError::Blocked(
                "Git tree asset identity resolved to conflicting workspace content".into(),
            ));
        }
        self.assets
            .insert(metadata.target_relative_path.clone(), metadata);
        Ok(())
    }

    fn record_saved_snapshot(&mut self, tree: &str, session_id: &str) -> Result<(), TransferError> {
        let started = Instant::now();
        let result = self.record_saved_snapshot_inner(tree, session_id);
        self.packed_decoders.costs.saved_reference_attempts = self
            .packed_decoders
            .costs
            .saved_reference_attempts
            .saturating_add(1);
        self.packed_decoders.costs.saved_reference_us = self
            .packed_decoders
            .costs
            .saved_reference_us
            .saturating_add(elapsed_us(started));
        self.refresh_reader_costs();
        result
    }

    fn refresh_reader_costs(&mut self) {
        if let Some(progress) = &mut self.source_progress {
            progress.event.reader_costs = Some(self.packed_decoders.costs.clone());
            progress.progress(progress.event.completed_count, progress.event.total_count);
        }
    }

    fn record_saved_snapshot_inner(
        &mut self,
        tree: &str,
        session_id: &str,
    ) -> Result<(), TransferError> {
        if tree.len() != 40 || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(TransferError::Blocked(
                "saved snapshot is not a SHA1 tree reference".into(),
            ));
        }
        #[cfg(test)]
        snapshot_reuse_test_hooks::before_reference();
        let mount = self.workspace_mounts.get(session_id).ok_or_else(|| {
            TransferError::Blocked("saved snapshot lacks an exact qualified workspace".into())
        })?;
        let project_id = self
            .snapshot_projects
            .get(session_id)
            .ok_or_else(|| {
                TransferError::Blocked("saved snapshot lacks its native project".into())
            })?
            .clone();
        checked_relative_path(&project_id)?;
        let worktree_sha1 = hex::encode(sha1::Sha1::digest(
            mount.canonical_root.to_string_lossy().as_bytes(),
        ));
        let data_home = self.snapshot_data_home.as_ref().ok_or_else(|| {
            TransferError::Blocked("saved snapshot lacks original datahome".into())
        })?;
        let native_bucket = data_home
            .join("snapshot")
            .join(&project_id)
            .join(&worktree_sha1);
        let workspace_store = snapshot_workspace_objects(&mount.canonical_root)?;
        let stores = qualified_snapshot_stores(&native_bucket, &workspace_store)?;
        self.packed_decoders
            .qualify(&native_bucket, &workspace_store, &stores)?;
        let closure = walk_snapshot_closure(tree, snapshot_closure_bound(), |id, remaining| {
            // Storage authority and bytes are re-established for every object
            // occurrence, before any resident computation can be reused.
            let object = self.packed_decoders.read(&stores, id);
            if let Some(progress) = &mut self.source_progress {
                progress.event.reader_costs = Some(self.packed_decoders.costs.clone());
                progress.progress(progress.event.completed_count.saturating_add(1), None);
            }
            let result = object.and_then(|object| {
                object
                    .map(|object| {
                        self.object_representations.resolve(
                            id,
                            object,
                            remaining,
                            self.snapshot_objects.get(&(
                                project_id.clone(),
                                worktree_sha1.clone(),
                                id.to_string(),
                            )),
                            &mut self.packed_decoders.costs,
                        )
                    })
                    .transpose()
            });
            self.refresh_reader_costs();
            result
        })?;
        let mut objects = Vec::new();
        if let Some(closure) = closure {
            for (object_id, (_, representation)) in closure {
                objects.push(representation.metadata);
                // Each native destination keeps its own tuple while sharing
                // the one validated serialized content allocation.
                self.snapshot_objects.insert(
                    (project_id.clone(), worktree_sha1.clone(), object_id),
                    representation.output,
                );
            }
        }
        let availability = if objects.is_empty() {
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        } else {
            SavedSnapshotAvailability::RetainedClosure
        };
        self.saved_snapshots.insert(
            (session_id.to_string(), tree.to_string()),
            SavedSnapshotReference {
                session_id: session_id.into(),
                project_id,
                worktree_sha1,
                tree: tree.into(),
                availability,
                objects,
            },
        );
        Ok(())
    }
}

fn snapshot_workspace_objects(workspace: &Path) -> Result<PathBuf, TransferError> {
    let marker = workspace.join(".git");
    let metadata = match fs::symlink_metadata(&marker) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(marker.join("objects")),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() {
        return Err(TransferError::Blocked(
            "snapshot Git directory marker is redirected".into(),
        ));
    }
    let mut git_dir = if metadata.is_dir() {
        marker
    } else if metadata.is_file() {
        let pointer = fs::read_to_string(&marker)?;
        let relative = pointer.trim().strip_prefix("gitdir: ").ok_or_else(|| {
            TransferError::Blocked("snapshot Git directory pointer is invalid".into())
        })?;
        let target = PathBuf::from(relative);
        if target.is_absolute() {
            target
        } else {
            workspace.join(target)
        }
    } else {
        return Err(TransferError::Blocked(
            "snapshot Git directory marker is invalid".into(),
        ));
    };
    git_dir = git_dir.canonicalize()?;
    if let Some(common) = read_alternates_file(&git_dir.join("commondir"))? {
        let common = PathBuf::from(common.trim());
        git_dir = if common.is_absolute() {
            common
        } else {
            git_dir.join(common)
        }
        .canonicalize()?;
    }
    if let Some(config) = read_alternates_file(&git_dir.join("config"))? {
        if config.lines().any(|line| {
            line.trim().to_ascii_lowercase().starts_with("objectformat")
                && !line.to_ascii_lowercase().ends_with("sha1")
        }) {
            return Err(TransferError::Blocked(
                "saved snapshot source uses an unsupported Git object format".into(),
            ));
        }
    }
    Ok(git_dir.join("objects"))
}

fn qualified_snapshot_stores(
    native_bucket: &Path,
    workspace_objects: &Path,
) -> Result<Vec<PathBuf>, TransferError> {
    let mut stores = Vec::new();
    for path in [
        native_bucket.join("objects"),
        workspace_objects.to_path_buf(),
    ] {
        match snapshot_symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(TransferError::Blocked(
                    "qualified snapshot object store is not a directory".into(),
                ))
            }
            Ok(_) => {}
        }
        // Every component must resolve as written, so a retained store cannot
        // silently redirect into an unrelated location.
        if snapshot_canonicalize(&path)? != path {
            return Err(TransferError::Blocked(
                "qualified snapshot store contains a redirected component".into(),
            ));
        }
        if let Some(alternates) = read_alternates_file(&path.join("info/alternates"))? {
            for alternate in alternates.lines().filter(|line| !line.trim().is_empty()) {
                let alternate = PathBuf::from(alternate);
                let alternate = if alternate.is_absolute() {
                    alternate
                } else {
                    path.join(alternate)
                };
                let qualified_workspace = workspace_objects
                    .parent()
                    .and_then(Path::parent)
                    .ok_or_else(|| {
                        TransferError::Blocked("snapshot alternate lacks source context".into())
                    })?;
                let alternate = snapshot_canonicalize(&alternate)?;
                if !alternate.starts_with(qualified_workspace) {
                    return Err(TransferError::Blocked(
                        "saved snapshot alternate is outside its qualified source repository"
                            .into(),
                    ));
                }
                if read_alternates_file(&alternate.join("info/alternates"))?
                    .is_some_and(|nested| nested.lines().any(|line| !line.trim().is_empty()))
                {
                    return Err(TransferError::Blocked(
                        "nested saved snapshot alternates are unsupported".into(),
                    ));
                }
                stores.push(alternate);
            }
        }
        stores.push(path);
    }
    Ok(stores)
}

enum SnapshotObjectSource {
    Loose(Vec<u8>),
    // This body has passed current native framing, bounds, kind and SHA1
    // validation. It is never retained by the export-local memo.
    Packed { kind: String, body: Vec<u8> },
}

impl SnapshotObjectSource {
    fn compressed(self) -> Result<Vec<u8>, TransferError> {
        match self {
            Self::Loose(compressed) => Ok(compressed),
            Self::Packed { kind, body } => compress_snapshot_object(&kind, &body),
        }
    }
}

fn compress_snapshot_object(kind: &str, body: &[u8]) -> Result<Vec<u8>, TransferError> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count("deflate");
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    write!(encoder, "{kind} {}\0", body.len())?;
    encoder.write_all(body)?;
    Ok(encoder.finish()?)
}

fn read_snapshot_object(
    stores: &[PathBuf],
    object_id: &str,
) -> Result<Option<Vec<u8>>, TransferError> {
    read_snapshot_object_source(stores, object_id)?
        .map(SnapshotObjectSource::compressed)
        .transpose()
}

fn read_snapshot_object_source(
    stores: &[PathBuf],
    object_id: &str,
) -> Result<Option<SnapshotObjectSource>, TransferError> {
    // Ordinary destination verification has independent, request-local state.
    let mut decoders = SnapshotPackedDecoders::default();
    let result = decoders.read(stores, object_id);
    let closed = decoders.finish();
    result.and_then(|object| closed.map(|()| object))
}

// Alternate count is unbounded; native processes, pipes and drain threads are not.
const MAX_RESIDENT_SNAPSHOT_DECODERS: usize = 4;

#[derive(Default)]
struct SnapshotPackedDecoders {
    context: Option<(PathBuf, PathBuf, Vec<PathBuf>)>,
    storage: Option<Vec<SnapshotStorageStamp>>,
    children: BTreeMap<PathBuf, SnapshotPackedDecoder>,
    costs: SourceReaderCosts,
    #[cfg(unix)]
    aggregate: Option<SnapshotPackedDecoder>,
    #[cfg(test)]
    residency_limit: Option<usize>,
}

impl SnapshotPackedDecoders {
    fn qualify(
        &mut self,
        native_bucket: &Path,
        workspace_store: &Path,
        stores: &[PathBuf],
    ) -> Result<(), TransferError> {
        let context = (
            native_bucket.to_path_buf(),
            workspace_store.to_path_buf(),
            stores.to_vec(),
        );
        if self.context.as_ref() != Some(&context) {
            self.finish()?;
            self.context = Some(context);
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), TransferError> {
        self.storage = None;
        self.finish_owners()
    }

    fn finish_owners(&mut self) -> Result<(), TransferError> {
        let started = Instant::now();
        // Join every owned child even when an earlier decoder failed.
        let mut result = Ok(());
        #[cfg(unix)]
        if let Some(mut decoder) = self.aggregate.take() {
            result = decoder.finish();
        }
        for (_, mut decoder) in std::mem::take(&mut self.children) {
            let closed = decoder.finish();
            if result.is_ok() {
                result = closed;
            }
        }
        self.costs.settlement_us = self.costs.settlement_us.saturating_add(elapsed_us(started));
        result
    }

    fn decoder(&mut self, store: &Path) -> Result<&mut SnapshotPackedDecoder, TransferError> {
        if !self.children.contains_key(store) {
            let limit = MAX_RESIDENT_SNAPSHOT_DECODERS;
            #[cfg(test)]
            let limit = self.residency_limit.unwrap_or(limit).max(1);
            if self.children.len() >= limit {
                // Close stdin, check late output/status, reap and join the
                // exact evicted child before opening replacement resources.
                let started = Instant::now();
                let closed = {
                    let (_, mut decoder) = self.children.pop_first().unwrap();
                    decoder.finish()
                };
                self.costs.settlement_us =
                    self.costs.settlement_us.saturating_add(elapsed_us(started));
                closed?;
            }
            let started = Instant::now();
            let spawned = SnapshotPackedDecoder::spawn(store);
            self.costs.native_spawns = self.costs.native_spawns.saturating_add(1);
            self.costs.native_spawn_us = self
                .costs
                .native_spawn_us
                .saturating_add(elapsed_us(started));
            self.children.insert(store.to_path_buf(), spawned?);
        }
        Ok(self.children.get_mut(store).unwrap())
    }

    fn has_pack(&self, store: &Path) -> bool {
        let pack = store.join("pack");
        self.storage.as_ref().is_some_and(|storage| {
            storage
                .iter()
                .any(|stamp| stamp.path.parent() == Some(pack.as_path()))
        })
    }

    #[cfg(unix)]
    fn use_aggregate(&self, stores: &[PathBuf]) -> bool {
        let enabled = stores.len() > 1;
        #[cfg(test)]
        let enabled = enabled
            && !snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().aggregate_disabled);
        enabled
    }

    fn read(
        &mut self,
        stores: &[PathBuf],
        object_id: &str,
    ) -> Result<Option<SnapshotObjectSource>, TransferError> {
        if object_id.len() != 40 || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(TransferError::Blocked(
                "snapshot closure has an invalid object ID".into(),
            ));
        }
        // Current loose objects keep precedence over every packed decoder.
        let started = Instant::now();
        let loose = (|| {
            for store in stores {
                let path = store.join(&object_id[..2]).join(&object_id[2..]);
                match fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                    Ok(metadata)
                        if !metadata.is_file()
                            || metadata.file_type().is_symlink()
                            || path.canonicalize()? != path =>
                    {
                        return Err(TransferError::Blocked(
                            "saved snapshot object is not an exact regular file".into(),
                        ))
                    }
                    Ok(metadata) if metadata.len() > MAX_BUNDLE_BYTES => {
                        return Err(TransferError::Blocked(
                            "saved snapshot object exceeds the transfer bound".into(),
                        ))
                    }
                    Ok(_) => return Ok(Some(SnapshotObjectSource::Loose(fs::read(path)?))),
                }
            }
            Ok(None)
        })();
        self.costs.loose_lookup_attempts = self.costs.loose_lookup_attempts.saturating_add(1);
        self.costs.loose_lookup_us = self
            .costs
            .loose_lookup_us
            .saturating_add(elapsed_us(started));
        if let Some(object) = loose? {
            return Ok(Some(object));
        }
        // Git retains pack descriptors and negative lookup state. Freshly
        // inspect all ordered stores before EVERY native query, including
        // directory/file identity, pack metadata and alternate/config bytes.
        let started = Instant::now();
        let inspected = (|| {
            #[cfg(test)]
            if snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().legacy_observation) {
                if let Some((native, workspace, qualified)) = &self.context {
                    if qualified_snapshot_stores(native, workspace)? != *qualified {
                        self.finish()?;
                        return Err(TransferError::Blocked(
                            "packed snapshot source context changed during its current read".into(),
                        ));
                    }
                }
                return legacy_snapshot_packed_storage(stores);
            }
            if let Some((native, workspace, qualified)) = &self.context {
                let (current, stamps) = observe_current_snapshot_sources(native, workspace)?;
                if current != *qualified {
                    self.finish()?;
                    return Err(TransferError::Blocked(
                        "packed snapshot source context changed during its current read".into(),
                    ));
                }
                Ok(stamps)
            } else {
                snapshot_packed_storage(stores)
            }
        })();
        self.costs.fresh_inspections = self.costs.fresh_inspections.saturating_add(1);
        self.costs.fresh_inspection_us = self
            .costs
            .fresh_inspection_us
            .saturating_add(elapsed_us(started));
        let storage = inspected?;
        if self.storage.as_ref() != Some(&storage) {
            self.finish()?;
            self.storage = Some(storage);
        }
        let packed_stores = stores.iter().filter(|store| self.has_pack(store)).count() as u64;
        self.costs.packed_store_high_water = self.costs.packed_store_high_water.max(packed_stores);
        // A success proves the requested current content, not the health of
        // unselected duplicate copies. A miss/rejected response is provisional:
        // settle this exact owner before independently reading ordered stores.
        #[cfg(unix)]
        if self.use_aggregate(stores) && packed_stores > 0 {
            if !self.children.is_empty() {
                self.finish_owners()?;
            }
            if self.aggregate.is_none() {
                let git_dir = stores
                    .iter()
                    .find(|store| self.has_pack(store))
                    .unwrap()
                    .parent()
                    .unwrap();
                let started = Instant::now();
                let spawned = SnapshotPackedDecoder::spawn_aggregate(stores, git_dir);
                self.costs.native_spawns = self.costs.native_spawns.saturating_add(1);
                self.costs.native_spawn_us = self
                    .costs
                    .native_spawn_us
                    .saturating_add(elapsed_us(started));
                if spawned.is_err() {
                    self.costs.aggregate_rejections =
                        self.costs.aggregate_rejections.saturating_add(1);
                }
                self.aggregate = spawned.ok();
            }
            if let Some(decoder) = &mut self.aggregate {
                let started = Instant::now();
                let result = decoder.read(object_id);
                self.costs.native_queries = self.costs.native_queries.saturating_add(1);
                self.costs.native_query_us = self
                    .costs
                    .native_query_us
                    .saturating_add(elapsed_us(started));
                match result {
                    Ok(Some(object)) => return Ok(Some(object)),
                    Ok(None) => {}
                    Err(_) => {
                        self.costs.aggregate_rejections =
                            self.costs.aggregate_rejections.saturating_add(1)
                    }
                }
                self.finish_owners()?;
            }
            self.costs.aggregate_fallbacks = self.costs.aggregate_fallbacks.saturating_add(1);
        }
        for store in stores {
            if !self.has_pack(store) {
                continue;
            }
            self.decoder(store)?;
            let started = Instant::now();
            let result = self.children.get_mut(store).unwrap().read(object_id);
            self.costs.native_queries = self.costs.native_queries.saturating_add(1);
            self.costs.native_query_us = self
                .costs
                .native_query_us
                .saturating_add(elapsed_us(started));
            match result {
                Ok(Some(object)) => return Ok(Some(object)),
                Ok(None) => {}
                Err(error) => {
                    // A framing/identity/I/O error never leaves a reusable child.
                    let started = Instant::now();
                    self.children.remove(store);
                    self.costs.settlement_us =
                        self.costs.settlement_us.saturating_add(elapsed_us(started));
                    return Err(error);
                }
            }
        }
        Ok(None)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SnapshotStorageStamp {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    readonly: bool,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64, u32),
    context_bytes: Option<String>,
}

// These wrappers keep test counts at the actual acquisition boundary. They
// retain no path, metadata, bytes or absence after the caller's fresh query.
fn snapshot_symlink_metadata(path: impl AsRef<Path>) -> io::Result<fs::Metadata> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count_filesystem("fs_lstat");
    fs::symlink_metadata(path)
}

fn snapshot_canonicalize(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count_filesystem("fs_canonicalize");
    fs::canonicalize(path)
}

fn snapshot_resolved_metadata(path: impl AsRef<Path>) -> io::Result<fs::Metadata> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count_filesystem("fs_stat");
    fs::metadata(path)
}

fn snapshot_read_context(path: impl AsRef<Path>) -> io::Result<String> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count_filesystem("fs_read");
    fs::read_to_string(path)
}

fn snapshot_read_directory(path: impl AsRef<Path>) -> io::Result<fs::ReadDir> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count_filesystem("fs_read_dir");
    fs::read_dir(path)
}

fn snapshot_storage_stamp(
    path: PathBuf,
    context_bytes: Option<String>,
) -> Result<SnapshotStorageStamp, TransferError> {
    let metadata = snapshot_symlink_metadata(&path)?;
    Ok(snapshot_storage_stamp_from_metadata(
        path,
        &metadata,
        context_bytes,
    ))
}

fn snapshot_storage_stamp_from_metadata(
    path: PathBuf,
    metadata: &fs::Metadata,
    context_bytes: Option<String>,
) -> SnapshotStorageStamp {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    SnapshotStorageStamp {
        path,
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        readonly: metadata.permissions().readonly(),
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.mode(),
        ),
        context_bytes,
    }
}

fn snapshot_metadata_matches(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    snapshot_storage_stamp_from_metadata(PathBuf::new(), left, None)
        == snapshot_storage_stamp_from_metadata(PathBuf::new(), right, None)
}

fn snapshot_packed_storage(stores: &[PathBuf]) -> Result<Vec<SnapshotStorageStamp>, TransferError> {
    let mut stamps = Vec::new();
    for store in stores {
        let observed = observe_snapshot_store(store, false)?.unwrap();
        let alternates = observe_snapshot_context(&store.join("info/alternates"))?;
        append_snapshot_storage(&observed, &alternates, &mut stamps)?;
    }
    Ok(stamps)
}

// Observations live only through one current query. Previous decoder stamps
// are comparison targets; they never supply a current binding or file body.
struct SnapshotObservedPath {
    path: PathBuf,
    canonical: PathBuf,
    metadata: fs::Metadata,
}

struct SnapshotObservedContext {
    path: PathBuf,
    observed: Option<(fs::Metadata, String)>,
}

fn observe_snapshot_store(
    path: &Path,
    allow_absent: bool,
) -> Result<Option<SnapshotObservedPath>, TransferError> {
    let metadata = match snapshot_symlink_metadata(path) {
        Err(error) if allow_absent && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(TransferError::Blocked(
            "qualified snapshot object store is not a directory".into(),
        ));
    }
    let canonical = snapshot_canonicalize(path)?;
    if canonical != path {
        return Err(TransferError::Blocked(
            "qualified snapshot store contains a redirected component".into(),
        ));
    }
    #[cfg(test)]
    snapshot_reuse_test_hooks::observation_barrier("store_binding", path);
    Ok(Some(SnapshotObservedPath {
        path: path.to_path_buf(),
        canonical,
        metadata,
    }))
}

fn observe_snapshot_context(path: &Path) -> Result<SnapshotObservedContext, TransferError> {
    let metadata = match snapshot_symlink_metadata(path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(TransferError::Blocked(format!(
                "Git alternate metadata is unavailable: {error}"
            )))
        }
    };
    let observed = if let Some(metadata) = metadata {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(TransferError::Blocked(
                "Git alternate metadata is not a regular file".into(),
            ));
        }
        let bytes = snapshot_read_context(path).map_err(|error| {
            TransferError::Blocked(format!("Git alternate metadata cannot be read: {error}"))
        })?;
        Some((metadata, bytes))
    } else {
        None
    };
    #[cfg(test)]
    snapshot_reuse_test_hooks::observation_barrier("context_bytes", path);
    Ok(SnapshotObservedContext {
        path: path.to_path_buf(),
        observed,
    })
}

fn finish_snapshot_context(
    observed: &SnapshotObservedContext,
) -> Result<Option<SnapshotStorageStamp>, TransferError> {
    let current = match snapshot_symlink_metadata(&observed.path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match (&observed.observed, current) {
        (None, None) => Ok(None),
        (Some((metadata, bytes)), Some(current))
            if snapshot_metadata_matches(metadata, &current) =>
        {
            Ok(Some(snapshot_storage_stamp_from_metadata(
                observed.path.clone(),
                &current,
                Some(bytes.clone()),
            )))
        }
        _ => Err(TransferError::Blocked(
            "snapshot context changed during its current observation".into(),
        )),
    }
}

fn append_snapshot_storage(
    store: &SnapshotObservedPath,
    alternates: &SnapshotObservedContext,
    stamps: &mut Vec<SnapshotStorageStamp>,
) -> Result<(), TransferError> {
    let git_dir = store.path.parent().ok_or_else(|| {
        TransferError::Blocked("snapshot store lacks native Git directory".into())
    })?;
    // Keep the final canonical check followed by current lexical metadata.
    // This same guarded result supplies the full stamp without another lstat.
    let canonical = snapshot_canonicalize(&store.path)?;
    #[cfg(test)]
    snapshot_reuse_test_hooks::observation_barrier("store_final_binding", &store.path);
    let current = snapshot_symlink_metadata(&store.path)?;
    if !current.is_dir()
        || current.file_type().is_symlink()
        || canonical != store.canonical
        || !snapshot_metadata_matches(&store.metadata, &current)
    {
        return Err(TransferError::Blocked(
            "qualified snapshot store changed during its current observation".into(),
        ));
    }
    stamps.push(snapshot_storage_stamp(git_dir.to_path_buf(), None)?);
    stamps.push(snapshot_storage_stamp_from_metadata(
        store.path.clone(),
        &current,
        None,
    ));
    for path in [git_dir.join("config"), git_dir.join("commondir")] {
        if let Some(stamp) = finish_snapshot_context(&observe_snapshot_context(&path)?)? {
            stamps.push(stamp);
        }
    }
    if let Some(stamp) = finish_snapshot_context(alternates)? {
        stamps.push(stamp);
    }
    let Some(pack) = observe_git_storage_path(
        git_dir,
        &store.path.join("pack"),
        "Git pack directory",
        true,
    )?
    else {
        return Ok(());
    };
    stamps.push(snapshot_storage_stamp_from_metadata(
        store.path.join("pack"),
        &pack.metadata,
        None,
    ));
    let mut files = snapshot_read_directory(&pack.canonical)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    for path in files {
        let observed = observe_git_storage_path(git_dir, &path, "Git pack file", false)?;
        // Enumeration followed by disappearance still refuses, as the old
        // stamp acquisition did, rather than silently dropping a pack entry.
        let observed = observed.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Git pack file is unavailable")
        })?;
        stamps.push(snapshot_storage_stamp_from_metadata(
            path,
            &observed.metadata,
            None,
        ));
    }
    Ok(())
}

fn observe_current_snapshot_sources(
    native_bucket: &Path,
    workspace_objects: &Path,
) -> Result<(Vec<PathBuf>, Vec<SnapshotStorageStamp>), TransferError> {
    let mut stores = Vec::new();
    let mut stamps = Vec::new();
    for path in [
        native_bucket.join("objects"),
        workspace_objects.to_path_buf(),
    ] {
        let Some(primary) = observe_snapshot_store(&path, true)? else {
            continue;
        };
        let alternates = observe_snapshot_context(&path.join("info/alternates"))?;
        if let Some((_, bytes)) = &alternates.observed {
            for alternate in bytes.lines().filter(|line| !line.trim().is_empty()) {
                let alternate = PathBuf::from(alternate);
                let alternate = if alternate.is_absolute() {
                    alternate
                } else {
                    path.join(alternate)
                };
                let qualified_workspace = workspace_objects
                    .parent()
                    .and_then(Path::parent)
                    .ok_or_else(|| {
                        TransferError::Blocked("snapshot alternate lacks source context".into())
                    })?;
                let alternate = snapshot_canonicalize(&alternate)?;
                if !alternate.starts_with(qualified_workspace) {
                    return Err(TransferError::Blocked(
                        "saved snapshot alternate is outside its qualified source repository"
                            .into(),
                    ));
                }
                let nested = observe_snapshot_context(&alternate.join("info/alternates"))?;
                if nested
                    .observed
                    .as_ref()
                    .is_some_and(|(_, bytes)| bytes.lines().any(|line| !line.trim().is_empty()))
                {
                    return Err(TransferError::Blocked(
                        "nested saved snapshot alternates are unsupported".into(),
                    ));
                }
                let alternate_observation = observe_snapshot_store(&alternate, false)?.unwrap();
                append_snapshot_storage(&alternate_observation, &nested, &mut stamps)?;
                stores.push(alternate);
            }
        }
        append_snapshot_storage(&primary, &alternates, &mut stamps)?;
        stores.push(path);
    }
    Ok((stores, stamps))
}

// Executed pre-sharing acquisition sequence, retained only as a behavioral
// reference for complete stamps, exports and actual filesystem-operation cost.
#[cfg(test)]
fn legacy_snapshot_storage_stamp(
    path: PathBuf,
    context_bytes: Option<String>,
) -> Result<SnapshotStorageStamp, TransferError> {
    let metadata = snapshot_symlink_metadata(&path)?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(SnapshotStorageStamp {
        path,
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        readonly: metadata.permissions().readonly(),
        #[cfg(unix)]
        identity: (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
            metadata.mode(),
        ),
        context_bytes,
    })
}

#[cfg(test)]
fn legacy_snapshot_packed_storage(
    stores: &[PathBuf],
) -> Result<Vec<SnapshotStorageStamp>, TransferError> {
    let mut stamps = Vec::new();
    for store in stores {
        let git_dir = store.parent().ok_or_else(|| {
            TransferError::Blocked("snapshot store lacks native Git directory".into())
        })?;
        let metadata = snapshot_symlink_metadata(store)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || snapshot_canonicalize(store)? != *store
        {
            return Err(TransferError::Blocked(
                "qualified snapshot store contains a redirected component".into(),
            ));
        }
        stamps.push(legacy_snapshot_storage_stamp(git_dir.to_path_buf(), None)?);
        stamps.push(legacy_snapshot_storage_stamp(store.clone(), None)?);
        for path in [
            git_dir.join("config"),
            git_dir.join("commondir"),
            store.join("info/alternates"),
        ] {
            if let Some(bytes) = read_alternates_file(&path)? {
                stamps.push(legacy_snapshot_storage_stamp(path, Some(bytes))?);
            }
        }
        let Some(pack) =
            checked_git_storage_path(git_dir, &store.join("pack"), "Git pack directory", true)?
        else {
            continue;
        };
        stamps.push(legacy_snapshot_storage_stamp(store.join("pack"), None)?);
        let mut files = snapshot_read_directory(pack)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<Vec<_>, _>>()?;
        files.sort();
        for path in files {
            checked_git_storage_path(git_dir, &path, "Git pack file", false)?;
            stamps.push(legacy_snapshot_storage_stamp(path, None)?);
        }
    }
    Ok(stamps)
}

struct SnapshotPackedDecoder {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    stderr: Option<std::thread::JoinHandle<io::Result<Vec<u8>>>>,
    settled: bool,
}

impl SnapshotPackedDecoder {
    fn spawn(store: &Path) -> Result<Self, TransferError> {
        let git_dir = store.parent().ok_or_else(|| {
            TransferError::Blocked("snapshot store lacks native Git directory".into())
        })?;
        Self::from_command(Self::command(git_dir))
    }

    fn command(git_dir: &Path) -> Command {
        let mut command = sanitized_git_command();
        command
            .arg("--git-dir")
            .arg(git_dir)
            .arg("--work-tree")
            .arg(git_dir)
            .arg("cat-file")
            .arg("--batch");
        command
    }

    #[cfg(unix)]
    fn spawn_aggregate(stores: &[PathBuf], git_dir: &Path) -> Result<Self, TransferError> {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let mut alternates = Vec::new();
        for store in &stores[1..] {
            if !alternates.is_empty() {
                alternates.push(b':');
            }
            // Git accepts C-quoted paths in its alternate-directory list.
            // Preserve native path bytes, including list separators and nonUTF8.
            alternates.push(b'"');
            for &byte in store.as_os_str().as_bytes() {
                match byte {
                    b'"' | b'\\' => alternates.extend_from_slice(&[b'\\', byte]),
                    0x20..=0x7e => alternates.push(byte),
                    _ => alternates.extend_from_slice(format!("\\{byte:03o}").as_bytes()),
                }
            }
            alternates.push(b'"');
        }
        let mut command = Self::command(git_dir);
        command.env("GIT_OBJECT_DIRECTORY", &stores[0]).env(
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            std::ffi::OsString::from_vec(alternates),
        );
        Self::from_command(command)
    }

    fn from_command(mut command: Command) -> Result<Self, TransferError> {
        #[cfg(all(test, unix))]
        {
            command = snapshot_reuse_test_hooks::late_owner_command(command);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("packed_spawn");
        let input = child.stdin.take();
        // Piped handles are supplied by Command; immediately wrap the child
        // so every subsequent error owns kill/wait/join cleanup.
        let output = BufReader::new(child.stdout.take().expect("piped Git stdout"));
        let mut stderr = child.stderr.take().expect("piped Git stderr");
        let drain = std::thread::Builder::new()
            .name("snapshot-git-stderr".into())
            .spawn(move || {
                let mut retained = Vec::new();
                let mut bytes = [0; 8192];
                loop {
                    let count = stderr.read(&mut bytes)?;
                    if count == 0 {
                        break;
                    }
                    let keep = count.min(16 * 1024 - retained.len());
                    retained.extend_from_slice(&bytes[..keep]);
                }
                Ok(retained)
            });
        let drain = match drain {
            Ok(drain) => drain,
            Err(error) => {
                drop(input);
                let _ = child.kill();
                let _ = child.wait();
                #[cfg(test)]
                snapshot_reuse_test_hooks::count("packed_reap");
                return Err(error.into());
            }
        };
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("packed_drain_spawn");
        Ok(Self {
            child,
            input,
            output,
            stderr: Some(drain),
            settled: false,
        })
    }

    fn read(&mut self, object_id: &str) -> Result<Option<SnapshotObjectSource>, TransferError> {
        let input = self.input.as_mut().ok_or_else(|| {
            TransferError::Blocked("packed snapshot decoder input is unavailable".into())
        })?;
        writeln!(input, "{object_id}")?;
        input.flush()?;
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("packed_query");
        let result = read_packed_snapshot_response(object_id, &mut self.output)?;
        if !self.output.buffer().is_empty() {
            return Err(TransferError::Blocked(
                "packed snapshot decoder returned trailing output".into(),
            ));
        }
        Ok(result)
    }

    fn finish(&mut self) -> Result<(), TransferError> {
        if self.settled {
            return Ok(());
        }
        self.input.take();
        // Drain without retaining output; unsolicited bytes remain a refusal.
        let mut trailing = false;
        let mut bytes = [0; 8192];
        loop {
            let count = self.output.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            trailing = true;
        }
        let status = self.child.wait()?;
        self.settled = true;
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("packed_reap");
        let stderr = self.stderr.take().unwrap().join();
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("packed_drain_join");
        let stderr = stderr.map_err(|_| {
            TransferError::Blocked("packed snapshot decoder stderr reader failed".into())
        })??;
        if !status.success() || trailing {
            return Err(TransferError::Blocked(format!(
                "packed snapshot decoder failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            )));
        }
        Ok(())
    }
}

impl Drop for SnapshotPackedDecoder {
    fn drop(&mut self) {
        if !self.settled {
            self.input.take();
            // Only this exact owned native decoder can be stopped here.
            let _ = self.child.kill();
            let _ = self.child.wait();
            #[cfg(test)]
            snapshot_reuse_test_hooks::count("packed_reap");
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
            #[cfg(test)]
            snapshot_reuse_test_hooks::count("packed_drain_join");
        }
    }
}

fn read_packed_snapshot_response(
    object_id: &str,
    output: &mut impl BufRead,
) -> Result<Option<SnapshotObjectSource>, TransferError> {
    // Read the small protocol header before accepting a declared allocation.
    let mut header = Vec::new();
    loop {
        let mut byte = [0];
        output.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        if header.len() == 128 {
            return Err(TransferError::Blocked(
                "packed snapshot decoder returned an oversized header".into(),
            ));
        }
        header.push(byte[0]);
    }
    let header = std::str::from_utf8(&header).map_err(|_| {
        TransferError::Blocked("packed snapshot decoder returned a nontext header".into())
    })?;
    let Some((kind, length)) = packed_snapshot_header(object_id, header)? else {
        return Ok(None);
    };
    let mut body = Vec::new();
    let mut remaining = length;
    let mut bytes = [0; 64 * 1024];
    while remaining > 0 {
        let count = remaining.min(bytes.len());
        output.read_exact(&mut bytes[..count])?;
        body.extend_from_slice(&bytes[..count]);
        remaining -= count;
    }
    let mut newline = [0];
    output.read_exact(&mut newline)?;
    if newline != [b'\n'] {
        return Err(TransferError::Blocked(
            "packed snapshot decoder returned an incomplete object".into(),
        ));
    }
    validate_packed_snapshot_identity(object_id, kind, &body)?;
    Ok(Some(SnapshotObjectSource::Packed {
        kind: kind.to_string(),
        body,
    }))
}

fn packed_snapshot_header<'a>(
    object_id: &str,
    header: &'a str,
) -> Result<Option<(&'a str, usize)>, TransferError> {
    let fields = header.split(' ').collect::<Vec<_>>();
    if fields.as_slice() == [object_id, "missing"] {
        return Ok(None);
    }
    if fields.len() != 3 || fields[0] != object_id || !matches!(fields[1], "tree" | "blob") {
        return Err(TransferError::Blocked(
            "packed snapshot decoder returned an unsupported object".into(),
        ));
    }
    let length = fields[2].parse::<usize>().map_err(|_| {
        TransferError::Blocked("packed snapshot decoder returned an invalid size".into())
    })?;
    let canonical_header = format!("{} {length}\0", fields[1]);
    if (length as u64).saturating_add(canonical_header.len() as u64) > MAX_BUNDLE_BYTES {
        return Err(TransferError::Blocked(
            "packed snapshot decoder returned an incomplete or oversized object".into(),
        ));
    }
    Ok(Some((fields[1], length)))
}

fn validate_packed_snapshot_identity(
    object_id: &str,
    kind: &str,
    body: &[u8],
) -> Result<(), TransferError> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count("packed_validate");
    let header = format!("{kind} {}\0", body.len());
    if (header.len() as u64).saturating_add(body.len() as u64) > MAX_BUNDLE_BYTES {
        return Err(TransferError::Blocked(
            "snapshot object bytes do not match their content identity".into(),
        ));
    }
    let mut hasher = sha1::Sha1::new();
    hasher.update(header.as_bytes());
    hasher.update(body);
    if hex::encode(hasher.finalize()) != object_id {
        return Err(TransferError::Blocked(
            "snapshot object bytes do not match their content identity".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
fn decode_packed_snapshot_response<'a>(
    object_id: &str,
    output: &'a [u8],
) -> Result<Option<(&'a str, &'a [u8])>, TransferError> {
    let newline = output
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| {
            TransferError::Blocked("packed snapshot decoder returned an incomplete header".into())
        })?;
    let header = std::str::from_utf8(&output[..newline]).map_err(|_| {
        TransferError::Blocked("packed snapshot decoder returned a nontext header".into())
    })?;
    let Some((kind, length)) = packed_snapshot_header(object_id, header)? else {
        if output.len() != newline + 1 {
            return Err(TransferError::Blocked(
                "packed snapshot decoder returned trailing output".into(),
            ));
        }
        return Ok(None);
    };
    if output.len().checked_sub(newline + 1) != length.checked_add(1)
        || output.last() != Some(&b'\n')
    {
        return Err(TransferError::Blocked(
            "packed snapshot decoder returned an incomplete or oversized object".into(),
        ));
    }
    Ok(Some((kind, &output[newline + 1..output.len() - 1])))
}

#[cfg(test)]
mod packed_snapshot_response_tests {
    use super::*;

    #[test]
    fn packed_stream_validates_before_allocation_and_rejects_current_wrong_bytes() {
        let id = hex::encode(sha1::Sha1::digest(b"blob 3\0abc"));
        let valid = format!("{id} blob 3\nabc\n");
        let Some(SnapshotObjectSource::Packed { kind, body }) =
            read_packed_snapshot_response(&id, &mut io::Cursor::new(valid.as_bytes())).unwrap()
        else {
            panic!("actual valid frame must decode");
        };
        assert_eq!(kind, "blob");
        assert_eq!(body, b"abc");
        assert!(read_packed_snapshot_response(
            &id,
            &mut io::Cursor::new(format!("{id} missing\n"))
        )
        .unwrap()
        .is_none());
        for invalid in [
            format!("{id} blob 3\nabx\n"),
            format!("{id} blob 3\nabc!"),
            format!("{id} blob 3\nab"),
            format!("{id} commit 3\nabc\n"),
            format!("{} blob 3\nabc\n", "f".repeat(40)),
            format!("{id} blob nope\n"),
            "x".repeat(130),
        ] {
            assert!(
                read_packed_snapshot_response(&id, &mut io::Cursor::new(&invalid)).is_err(),
                "{invalid}"
            );
        }
        let header = format!("{id} blob {MAX_BUNDLE_BYTES}\n");
        let mut oversized = io::Cursor::new(format!("{header}never-read-body"));
        assert!(
            matches!(read_packed_snapshot_response(&id, &mut oversized), Err(TransferError::Blocked(reason)) if reason.contains("oversized"))
        );
        assert_eq!(
            oversized.position(),
            header.len() as u64,
            "the canonical raw bound is checked before reading or allocating the body"
        );
    }

    #[cfg(unix)]
    #[test]
    fn packed_decoder_drains_bounded_stderr_and_refuses_late_exit_after_valid_body() {
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let id = hex::encode(sha1::Sha1::digest(b"blob 3\0abc"));
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                r#"
            IFS= read -r oid || exit 2
            i=0
            while [ "$i" -lt 2000 ]; do
                printf '%s' 'owned fixture stderr intentionally exceeds pipe capacity........' >&2
                i=$((i + 1))
            done
            printf '%s blob 3\nabc\n' "$1"
            IFS= read -r ignored
            exit 9
        "#,
            )
            .arg("owned-packed-decoder-fixture")
            .arg(&id);
        let mut decoder = SnapshotPackedDecoder::from_command(command).unwrap();
        let Some(SnapshotObjectSource::Packed { body, .. }) = decoder.read(&id).unwrap() else {
            panic!("body precedes late child failure");
        };
        assert_eq!(body, b"abc");
        let failure = decoder.finish().unwrap_err();
        assert!(
            matches!(failure, TransferError::Blocked(ref reason) if reason.starts_with("packed snapshot decoder failed:") && reason.len() <= 16 * 1024 + 40)
        );
        assert!(!decoder.child.try_wait().unwrap().unwrap().success());
        drop(decoder);
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_spawn"], 1);
        assert_eq!(
            counts["packed_reap"], 1,
            "late refusal joins the exact child once"
        );
    }

    #[test]
    fn durable_souls_saved_snapshot_uses_qualified_linked_worktree_common_objects() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = fixture.path().join("workspace");
        let common = fixture.path().join("repo/.git");
        let worktree = common.join("worktrees/owned");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(common.join("objects")).unwrap();
        fs::write(
            workspace.join(".git"),
            format!("gitdir: {}\n", worktree.display()),
        )
        .unwrap();
        fs::write(worktree.join("commondir"), "../..\n").unwrap();
        fs::write(
            common.join("config"),
            "[core]\nrepositoryformatversion = 0\n",
        )
        .unwrap();
        assert_eq!(
            snapshot_workspace_objects(&workspace).unwrap(),
            common.canonicalize().unwrap().join("objects")
        );
        fs::write(
            common.join("config"),
            "[extensions]\nobjectFormat = sha256\n",
        )
        .unwrap();
        assert!(snapshot_workspace_objects(&workspace).is_err());
        fs::write(workspace.join(".git"), "unknown pointer\n").unwrap();
        assert!(snapshot_workspace_objects(&workspace).is_err());
    }

    #[test]
    fn durable_souls_packed_snapshot_distinguishes_absent_from_malformed_objects() {
        let id = "0123456789012345678901234567890123456789";
        assert!(
            decode_packed_snapshot_response(id, format!("{id} missing\n").as_bytes())
                .unwrap()
                .is_none()
        );
        assert_eq!(
            decode_packed_snapshot_response(id, format!("{id} blob 3\nabc\n").as_bytes()).unwrap(),
            Some(("blob", b"abc".as_slice()))
        );
        for response in [
            format!("{id} missing\nextra"),
            format!("{id} blob 4\nabc\n"),
            format!("{id} commit 3\nabc\n"),
            "other blob 3\nabc\n".to_string(),
        ] {
            assert!(decode_packed_snapshot_response(id, response.as_bytes()).is_err());
        }
    }
}

fn decode_snapshot_object(
    object_id: &str,
    compressed: &[u8],
) -> Result<(String, Vec<u8>), TransferError> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count("inflate");
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(compressed)
        .take(MAX_BUNDLE_BYTES + 1)
        .read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_BUNDLE_BYTES || hex::encode(sha1::Sha1::digest(&raw)) != object_id {
        return Err(TransferError::Blocked(
            "snapshot object bytes do not match their content identity".into(),
        ));
    }
    let nul = raw
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| TransferError::Blocked("snapshot object lacks its native header".into()))?;
    let header = std::str::from_utf8(&raw[..nul])
        .map_err(|_| TransferError::Blocked("snapshot object header is invalid".into()))?;
    let (kind, size) = header
        .split_once(' ')
        .ok_or_else(|| TransferError::Blocked("snapshot object header is invalid".into()))?;
    if !matches!(kind, "tree" | "blob") || size.parse::<usize>().ok() != Some(raw.len() - nul - 1) {
        return Err(TransferError::Blocked(
            "snapshot object has unsupported kind or length".into(),
        ));
    }
    Ok((kind.to_string(), raw[nul + 1..].to_vec()))
}

fn snapshot_tree_children(bytes: &[u8]) -> Result<Vec<(String, bool)>, TransferError> {
    #[cfg(test)]
    snapshot_reuse_test_hooks::count("tree_parse");
    let mut cursor = 0;
    let mut children = Vec::new();
    while cursor < bytes.len() {
        let space = bytes[cursor..]
            .iter()
            .position(|byte| *byte == b' ')
            .map(|n| cursor + n)
            .ok_or_else(|| TransferError::Blocked("snapshot tree entry mode is absent".into()))?;
        let nul = bytes[space + 1..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|n| space + 1 + n)
            .ok_or_else(|| TransferError::Blocked("snapshot tree entry name is absent".into()))?;
        let mode = std::str::from_utf8(&bytes[cursor..space]).unwrap_or("");
        let name = &bytes[space + 1..nul];
        if !matches!(
            mode,
            "40000" | "040000" | "100644" | "100755" | "120000" | "160000"
        ) || name.is_empty()
            || name == b"."
            || name == b".."
            || name.contains(&b'/')
            || nul + 21 > bytes.len()
        {
            return Err(TransferError::Blocked(
                "snapshot tree contains an unsupported entry".into(),
            ));
        }
        // A Gitlink names a commit in the submodule's separate repository.
        // Its mode/name/OID stay in this tree; it is not part of our closure.
        if mode != "160000" {
            children.push((
                hex::encode(&bytes[nul + 1..nul + 21]),
                matches!(mode, "40000" | "040000"),
            ));
        }
        cursor = nul + 21;
    }
    Ok(children)
}

fn read_snapshot_closure(
    stores: &[PathBuf],
    tree: &str,
) -> Result<Option<BTreeMap<String, Vec<u8>>>, TransferError> {
    read_snapshot_closure_with_reader(tree, |id| read_snapshot_object(stores, id))
}

struct SnapshotEdges {
    is_tree: bool,
    children: Vec<(String, bool)>,
}

fn validated_snapshot_edges(kind: &str, body: &[u8]) -> Result<SnapshotEdges, TransferError> {
    let is_tree = kind == "tree";
    Ok(SnapshotEdges {
        is_tree,
        children: if is_tree {
            snapshot_tree_children(body)?
        } else {
            Vec::new()
        },
    })
}

trait SnapshotClosureObject {
    type Retained;
    fn into_retained(self) -> Self::Retained;
    fn compressed_bytes(&self) -> u64;
    fn edges(&self) -> &SnapshotEdges;
}

struct DecodedSnapshotObject {
    compressed: Vec<u8>,
    edges: SnapshotEdges,
}

impl SnapshotClosureObject for DecodedSnapshotObject {
    type Retained = Vec<u8>;
    fn into_retained(self) -> Self::Retained {
        self.compressed
    }
    fn compressed_bytes(&self) -> u64 {
        self.compressed.len() as u64
    }
    fn edges(&self) -> &SnapshotEdges {
        &self.edges
    }
}

fn read_snapshot_closure_with_reader(
    tree: &str,
    mut read_object: impl FnMut(&str) -> Result<Option<Vec<u8>>, TransferError>,
) -> Result<Option<BTreeMap<String, Vec<u8>>>, TransferError> {
    Ok(
        walk_snapshot_closure(tree, MAX_BUNDLE_BYTES / 2, |id, remaining| {
            read_object(id)?
                .map(|compressed| {
                    check_snapshot_closure_bytes(compressed.len() as u64, remaining)?;
                    let (kind, body) = decode_snapshot_object(id, &compressed)?;
                    Ok(DecodedSnapshotObject {
                        compressed,
                        edges: validated_snapshot_edges(&kind, &body)?,
                    })
                })
                .transpose()
        })?
        .map(|closure| {
            closure
                .into_iter()
                .map(|(id, (_, compressed))| (id, compressed))
                .collect()
        }),
    )
}

type SnapshotClosure<T> = BTreeMap<String, (bool, T)>;

fn walk_snapshot_closure<T: SnapshotClosureObject>(
    tree: &str,
    bound: u64,
    mut read_object: impl FnMut(&str, u64) -> Result<Option<T>, TransferError>,
) -> Result<Option<SnapshotClosure<T::Retained>>, TransferError> {
    let Some(root) = read_object(tree, bound)? else {
        return Ok(None);
    };
    let mut pending = vec![(tree.to_string(), true, Some(root))];
    let mut closure: SnapshotClosure<T::Retained> = BTreeMap::new();
    let mut total = 0u64;
    while let Some((id, is_tree, known)) = pending.pop() {
        if let Some((retained_is_tree, _)) = closure.get(&id) {
            check_snapshot_kind(*retained_is_tree, is_tree)?;
            continue;
        }
        let object = match known {
            Some(object) => Some(object),
            None => read_object(&id, bound - total)?,
        }
        .ok_or_else(|| {
            TransferError::Blocked("retained snapshot has an incomplete tree closure".into())
        })?;
        total = total
            .checked_add(object.compressed_bytes())
            .filter(|size| *size <= bound)
            .ok_or_else(|| {
                TransferError::Blocked("snapshot closure exceeds its encoded transfer bound".into())
            })?;
        check_snapshot_kind(object.edges().is_tree, is_tree)?;
        for (child, is_tree) in &object.edges().children {
            pending.push((child.clone(), *is_tree, None));
        }
        // Adjacency belongs only to the bounded memo/current traversal, not
        // the retained closure or emitted output for nonresident objects.
        closure.insert(id, (is_tree, object.into_retained()));
    }
    Ok(Some(closure))
}

fn check_snapshot_closure_bytes(bytes: u64, remaining: u64) -> Result<(), TransferError> {
    if bytes > remaining {
        return Err(TransferError::Blocked(
            "snapshot closure exceeds its encoded transfer bound".into(),
        ));
    }
    Ok(())
}

fn check_snapshot_kind(actual_is_tree: bool, expected_is_tree: bool) -> Result<(), TransferError> {
    if actual_is_tree != expected_is_tree {
        return Err(TransferError::Blocked(
            "snapshot closure object kind differs from its tree edge".into(),
        ));
    }
    Ok(())
}

// Only computation is retained. Current authority/read failures never enter
// this memo; loose commitments and freshly validated packed bodies remain
// separate encodings. Clearing changes cost, never export acceptance.
const SNAPSHOT_REPRESENTATION_BUDGET: usize = 16 * 1024 * 1024;

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum SnapshotEncoding {
    Loose { bytes: u64, sha256: String },
    PackedDefault,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SnapshotOutputProvenance {
    Loose,
    PackedDefault,
}

// Required serialized output retains only its existing allocation and encoding
// provenance. Current body/adjacency authority stays in the native read/walk.
struct SnapshotOutput {
    compressed_hex: Arc<String>,
    provenance: SnapshotOutputProvenance,
}

struct SavedObjectRepresentation {
    edges: SnapshotEdges,
    metadata: SnapshotObjectMetadata,
    compressed_hex: Arc<String>,
    provenance: SnapshotOutputProvenance,
}

struct RetainedSnapshotObject {
    metadata: SnapshotObjectMetadata,
    output: SnapshotOutput,
}

impl SnapshotClosureObject for Arc<SavedObjectRepresentation> {
    type Retained = RetainedSnapshotObject;
    fn into_retained(self) -> Self::Retained {
        RetainedSnapshotObject {
            metadata: self.metadata.clone(),
            output: SnapshotOutput {
                compressed_hex: self.compressed_hex.clone(),
                provenance: self.provenance,
            },
        }
    }
    fn compressed_bytes(&self) -> u64 {
        self.metadata.compressed_bytes
    }
    fn edges(&self) -> &SnapshotEdges {
        &self.edges
    }
}

struct SnapshotRepresentations {
    resident: BTreeMap<(String, SnapshotEncoding), Arc<SavedObjectRepresentation>>,
    bytes: usize,
    budget: usize,
}

impl SnapshotRepresentations {
    fn new() -> Self {
        let budget = SNAPSHOT_REPRESENTATION_BUDGET;
        #[cfg(test)]
        let budget =
            snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().budget.unwrap_or(budget));
        Self {
            resident: BTreeMap::new(),
            bytes: 0,
            budget,
        }
    }

    fn resolve(
        &mut self,
        id: &str,
        object: SnapshotObjectSource,
        remaining: u64,
        output: Option<&SnapshotOutput>,
        costs: &mut SourceReaderCosts,
    ) -> Result<Arc<SavedObjectRepresentation>, TransferError> {
        let started = Instant::now();
        let result = self.resolve_inner(id, object, remaining, output, costs);
        costs.representation_us = costs.representation_us.saturating_add(elapsed_us(started));
        result
    }

    fn resolve_inner(
        &mut self,
        id: &str,
        object: SnapshotObjectSource,
        remaining: u64,
        output: Option<&SnapshotOutput>,
        costs: &mut SourceReaderCosts,
    ) -> Result<Arc<SavedObjectRepresentation>, TransferError> {
        let encoding = match &object {
            SnapshotObjectSource::Loose(compressed) => {
                check_snapshot_closure_bytes(compressed.len() as u64, remaining)?;
                SnapshotEncoding::Loose {
                    bytes: compressed.len() as u64,
                    sha256: digest(compressed),
                }
            }
            SnapshotObjectSource::Packed { .. } => SnapshotEncoding::PackedDefault,
        };
        let key = (id.to_string(), encoding);
        if let Some(resident) = self.resident.get(&key) {
            costs.representation_hits = costs.representation_hits.saturating_add(1);
            check_snapshot_closure_bytes(resident.metadata.compressed_bytes, remaining)?;
            return Ok(resident.clone());
        }
        costs.representation_misses = costs.representation_misses.saturating_add(1);
        #[cfg(test)]
        let output = output.filter(|_| {
            !snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().packed_output_disabled)
        });
        let provenance = match &object {
            SnapshotObjectSource::Loose(_) => SnapshotOutputProvenance::Loose,
            SnapshotObjectSource::Packed { .. } => SnapshotOutputProvenance::PackedDefault,
        };
        let (kind, body, compressed) = match object {
            SnapshotObjectSource::Loose(compressed) => {
                let (kind, body) = decode_snapshot_object(id, &compressed)?;
                (kind, body, compressed)
            }
            SnapshotObjectSource::Packed { kind, body } => {
                if let Some(output) = output
                    .filter(|output| output.provenance == SnapshotOutputProvenance::PackedDefault)
                {
                    let (compressed_bytes, compressed_sha256) =
                        snapshot_output_commitment(&output.compressed_hex)?;
                    check_snapshot_closure_bytes(compressed_bytes, remaining)?;
                    let representation = Arc::new(SavedObjectRepresentation {
                        edges: validated_snapshot_edges(&kind, &body)?,
                        metadata: SnapshotObjectMetadata {
                            object_id: id.to_string(),
                            compressed_bytes,
                            compressed_sha256,
                        },
                        compressed_hex: output.compressed_hex.clone(),
                        provenance,
                    });
                    return Ok(self.admit(key, representation));
                }
                let started = Instant::now();
                let compressed = compress_snapshot_object(&kind, &body);
                costs.compression_us = costs.compression_us.saturating_add(elapsed_us(started));
                (kind, body, compressed?)
            }
        };
        check_snapshot_closure_bytes(compressed.len() as u64, remaining)?;
        let edges = validated_snapshot_edges(&kind, &body)?;
        let metadata = SnapshotObjectMetadata {
            object_id: id.to_string(),
            compressed_bytes: compressed.len() as u64,
            compressed_sha256: match &key.1 {
                SnapshotEncoding::Loose { sha256, .. } => sha256.clone(),
                SnapshotEncoding::PackedDefault => digest(&compressed),
            },
        };
        #[cfg(test)]
        snapshot_reuse_test_hooks::count("hex");
        let representation = Arc::new(SavedObjectRepresentation {
            edges,
            metadata,
            compressed_hex: Arc::new(hex::encode(compressed)),
            provenance,
        });
        Ok(self.admit(key, representation))
    }

    fn admit(
        &mut self,
        key: (String, SnapshotEncoding),
        representation: Arc<SavedObjectRepresentation>,
    ) -> Arc<SavedObjectRepresentation> {
        // Include retained output bytes even though they normally share the
        // emitted map's allocation; replaced encodings must remain bounded too.
        let retained_bytes = representation
            .compressed_hex
            .len()
            .saturating_add(representation.edges.children.len().saturating_mul(128))
            .saturating_add(1024);
        if retained_bytes <= self.budget {
            if self.bytes.saturating_add(retained_bytes) > self.budget {
                self.resident.clear();
                self.bytes = 0;
            }
            self.bytes += retained_bytes;
            self.resident.insert(key, representation.clone());
            #[cfg(test)]
            snapshot_reuse_test_hooks::count("memo_admit");
        }
        representation
    }
}

fn snapshot_output_commitment(compressed_hex: &str) -> Result<(u64, String), TransferError> {
    let mut hasher = Sha256::new();
    let mut scratch = [0u8; 4096];
    for chunk in compressed_hex.as_bytes().chunks(scratch.len() * 2) {
        let decoded = &mut scratch[..chunk.len() / 2];
        hex::decode_to_slice(chunk, decoded).map_err(|_| {
            TransferError::Blocked("snapshot object has invalid encoded bytes".into())
        })?;
        hasher.update(decoded);
    }
    Ok((
        (compressed_hex.len() / 2) as u64,
        hex::encode(hasher.finalize()),
    ))
}

fn snapshot_closure_bound() -> u64 {
    let bound = MAX_BUNDLE_BYTES / 2;
    #[cfg(test)]
    let bound = snapshot_reuse_test_hooks::STATE
        .with(|state| state.borrow().closure_bound.unwrap_or(bound));
    bound
}

#[cfg(test)]
mod snapshot_reuse_test_hooks {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    type ObservationBarrier = Box<dyn FnMut(&str, &std::path::Path)>;

    #[derive(Default)]
    pub(super) struct State {
        pub counts: BTreeMap<&'static str, usize>,
        pub filesystem_counts: BTreeMap<&'static str, usize>,
        pub budget: Option<usize>,
        pub packed_output_disabled: bool,
        #[cfg(unix)]
        pub packed_late_fault: Option<(i32, bool, std::path::PathBuf)>,
        #[cfg_attr(not(unix), allow(dead_code))]
        pub aggregate_disabled: bool,
        pub before_reference: Option<Box<dyn FnMut(usize)>>,
        pub references: usize,
        pub legacy_observation: bool,
        pub observation_barrier: Option<ObservationBarrier>,
        pub closure_bound: Option<u64>,
    }
    thread_local! {
        pub(super) static STATE: RefCell<State> = RefCell::new(State::default());
    }
    #[cfg(unix)]
    pub(super) fn late_owner_command(command: std::process::Command) -> std::process::Command {
        let fault = STATE.with(|state| state.borrow().packed_late_fault.clone());
        let Some((status, trailing, pids)) = fault else {
            return command;
        };
        let mut wrapped = std::process::Command::new("python3");
        wrapped.args(["-c", "import os, pathlib, subprocess, sys\nchild = subprocess.Popen(sys.argv[4:])\npathlib.Path(sys.argv[3]).write_text(str(os.getpid()) + ' ' + str(child.pid))\nresult = child.wait()\nif sys.argv[2] == 'true': sys.stdout.buffer.write(b'late output')\nsys.exit(int(sys.argv[1]) if result == 0 else result)\n"]);
        wrapped
            .arg(status.to_string())
            .arg(trailing.to_string())
            .arg(pids)
            .arg(command.get_program())
            .args(command.get_args());
        for (key, value) in command.get_envs() {
            match value {
                Some(value) => {
                    wrapped.env(key, value);
                }
                None => {
                    wrapped.env_remove(key);
                }
            }
        }
        wrapped
    }
    pub(super) fn count_filesystem(operation: &'static str) {
        STATE.with(|state| {
            *state
                .borrow_mut()
                .filesystem_counts
                .entry(operation)
                .or_default() += 1
        });
    }
    #[cfg(unix)]
    pub(super) fn take_observation_counts() -> BTreeMap<&'static str, usize> {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let mut counts = std::mem::take(&mut state.counts);
            counts.append(&mut state.filesystem_counts);
            counts
        })
    }
    pub(super) fn observation_barrier(phase: &str, path: &std::path::Path) {
        let callback = STATE.with(|state| state.borrow_mut().observation_barrier.take());
        if let Some(mut callback) = callback {
            callback(phase, path);
            STATE.with(|state| state.borrow_mut().observation_barrier = Some(callback));
        }
    }
    pub(super) fn before_reference() {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.references += 1;
            let count = state.references;
            if let Some(callback) = &mut state.before_reference {
                callback(count);
            }
        });
    }
    pub(super) fn count(operation: &'static str) {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            let counts = &mut state.counts;
            *counts.entry(operation).or_default() += 1;
            for (spawn, settled, peak) in [
                ("packed_spawn", "packed_reap", "packed_peak"),
                (
                    "packed_drain_spawn",
                    "packed_drain_join",
                    "packed_drain_peak",
                ),
            ] {
                if operation == spawn {
                    let live = counts[spawn] - counts.get(settled).copied().unwrap_or(0);
                    let maximum = counts.entry(peak).or_default();
                    *maximum = (*maximum).max(live);
                }
            }
        });
    }
}

#[cfg(test)]
mod snapshot_closure_reader_tests {
    use super::*;

    fn object(kind: &str, bytes: &[u8]) -> (String, Vec<u8>) {
        let mut raw = format!("{kind} {}\0", bytes.len()).into_bytes();
        raw.extend_from_slice(bytes);
        let id = hex::encode(sha1::Sha1::digest(&raw));
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        (id, encoder.finish().unwrap())
    }

    fn fixture() -> (String, BTreeMap<String, Vec<u8>>) {
        let (blob, compressed_blob) = object("blob", b"synthetic saved content");
        let mut subtree = b"100644 nested\0".to_vec();
        subtree.extend_from_slice(&hex::decode(&blob).unwrap());
        let (subtree, compressed_subtree) = object("tree", &subtree);
        let mut children = Vec::new();
        for name in ["first", "shared"] {
            children.extend_from_slice(format!("100644 {name}\0").as_bytes());
            children.extend_from_slice(&hex::decode(&blob).unwrap());
        }
        children.extend_from_slice(b"40000 subtree\0");
        children.extend_from_slice(&hex::decode(&subtree).unwrap());
        let (tree, compressed_tree) = object("tree", &children);
        (
            tree.clone(),
            BTreeMap::from([
                (tree, compressed_tree),
                (blob, compressed_blob),
                (subtree, compressed_subtree),
            ]),
        )
    }

    #[test]
    fn supplied_root_and_each_unique_child_are_read_once() {
        let (tree, objects) = fixture();
        let mut reads = BTreeMap::new();
        let closure = read_snapshot_closure_with_reader(&tree, |id| {
            let count = reads.entry(id.to_string()).or_insert(0);
            *count += 1;
            if *count > 1 {
                return Err(TransferError::Io("unnecessary second read failed".into()));
            }
            Ok(objects.get(id).cloned())
        })
        .expect("retained bytes must not depend on a redundant root read")
        .unwrap();
        assert_eq!(closure, objects);
        assert_eq!(reads, objects.keys().map(|id| (id.clone(), 1)).collect());
    }

    #[test]
    fn closure_reader_still_refuses_incomplete_corrupt_and_wrong_kind_children() {
        let (tree, objects) = fixture();
        let child = objects.keys().find(|id| **id != tree).unwrap();
        for replacement in [
            None,
            Some(b"corrupt compressed bytes".to_vec()),
            Some(objects[&tree].clone()),
        ] {
            let result = read_snapshot_closure_with_reader(&tree, |id| {
                Ok(if id == child {
                    replacement.clone()
                } else {
                    objects.get(id).cloned()
                })
            });
            assert!(
                matches!(
                    result,
                    Err(TransferError::Blocked(_) | TransferError::Io(_))
                ),
                "{result:?}"
            );
        }
        assert!(read_snapshot_closure_with_reader(&tree, |_| Ok(None))
            .unwrap()
            .is_none());
        let (blob_id, blob) = object("blob", b"not a tree");
        assert!(matches!(
            read_snapshot_closure_with_reader(&blob_id, |_| Ok(Some(blob.clone()))),
            Err(TransferError::Blocked(_))
        ));
        let (child, compressed_child) = object("tree", &[]);
        let mut bytes = b"100644 wrong-kind\0".to_vec();
        bytes.extend_from_slice(&hex::decode(&child).unwrap());
        let (root, compressed_root) = object("tree", &bytes);
        let objects = BTreeMap::from([(root.clone(), compressed_root), (child, compressed_child)]);
        assert!(
            matches!(read_snapshot_closure_with_reader(&root, |id| Ok(objects.get(id).cloned())), Err(TransferError::Blocked(reason)) if reason == "snapshot closure object kind differs from its tree edge")
        );
    }

    #[test]
    fn progress_is_rate_limited_and_keeps_final_counts() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let options = ExportOptions::default()
            .with_progress_observer(move |event| observed.lock().unwrap().push(event));
        let mut phase = options.phase("saved_objects", Some("ses_synthetic"), "object_reads");
        for count in 1..=100 {
            phase.progress(count, None);
        }
        assert_eq!(
            events.lock().unwrap().len(),
            2,
            "one start plus first live update, without per-reference logs"
        );
        phase.last_progress = Some(Instant::now() - Duration::from_secs(6));
        phase.progress(101, None);
        phase.progress(102, None);
        phase.finish(None);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[2].state, "progress");
        assert_eq!(events[2].completed_count, 101);
        assert_eq!(events[3].state, "completed");
        assert_eq!(events[3].completed_count, 102);
        assert!(events
            .windows(2)
            .all(|pair| pair[0].elapsed_ms <= pair[1].elapsed_ms));
    }
}

/// Publish one immutable, content-addressed object. An interrupted database
/// import can leave identical objects; it cannot leave a completion receipt.
pub fn install_snapshot_object(
    object: &SerializedSnapshotObject,
    references: &[SavedSnapshotReference],
    destination_database: &Path,
) -> Result<(), TransferError> {
    checked_relative_path(&object.project_id)?;
    if object.worktree_sha1.len() != 40
        || !object
            .worktree_sha1
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(TransferError::Blocked(
            "snapshot native bucket identity is invalid".into(),
        ));
    }
    let expected = references
        .iter()
        .filter(|reference| {
            reference.project_id == object.project_id
                && reference.worktree_sha1 == object.worktree_sha1
        })
        .flat_map(|reference| &reference.objects)
        .find(|metadata| metadata.object_id == object.object_id)
        .ok_or_else(|| {
            TransferError::Blocked("snapshot object is outside the exact saved closure".into())
        })?;
    let bytes = hex::decode(&object.compressed_hex)
        .map_err(|_| TransferError::Blocked("snapshot object encoding is invalid".into()))?;
    if bytes.len() as u64 != expected.compressed_bytes
        || digest(&bytes) != expected.compressed_sha256
    {
        return Err(TransferError::Blocked(
            "snapshot object transport digest differs".into(),
        ));
    }
    decode_snapshot_object(&object.object_id, &bytes)?;
    let bucket = destination_database
        .parent()
        .ok_or_else(|| {
            TransferError::Blocked("snapshot destination lacks provider datahome".into())
        })?
        .join("snapshot")
        .join(&object.project_id)
        .join(&object.worktree_sha1);
    snapshot_create_directory(&bucket.join("objects").join(&object.object_id[..2]))?;
    snapshot_create_directory(&bucket.join("refs/heads"))?;
    publish_snapshot_file(&bucket.join("HEAD"), b"ref: refs/heads/master\n", false)?;
    publish_snapshot_file(
        &bucket.join("config"),
        b"[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n",
        false,
    )?;
    let target = bucket
        .join("objects")
        .join(&object.object_id[..2])
        .join(&object.object_id[2..]);
    publish_snapshot_file(&target, &bytes, true)?;
    Ok(())
}

fn snapshot_create_directory(path: &Path) -> Result<(), TransferError> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        match fs::symlink_metadata(current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => break,
            Ok(_) => {
                return Err(TransferError::Blocked(
                    "snapshot destination contains a non-directory component".into(),
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(current.to_path_buf());
                current = current.parent().ok_or_else(|| {
                    TransferError::Blocked("snapshot destination has no existing parent".into())
                })?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    if current.canonicalize()? != current {
        return Err(TransferError::Blocked(
            "snapshot destination parent is redirected".into(),
        ));
    }
    for directory in missing.into_iter().rev() {
        fs::create_dir(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn publish_snapshot_file(path: &Path, bytes: &[u8], object: bool) -> Result<(), TransferError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || path.canonicalize()? != path
            {
                return Err(TransferError::Blocked(
                    "snapshot destination is not an exact regular file".into(),
                ));
            }
            if object && fs::read(path)? != bytes {
                return Err(TransferError::Blocked(
                    "snapshot destination object conflicts with retained content".into(),
                ));
            }
            return Ok(());
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path
        .parent()
        .ok_or_else(|| TransferError::Blocked("snapshot file lacks parent".into()))?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(bytes)?;
    staged.as_file().sync_all()?;
    staged
        .persist_noclobber(path)
        .map_err(|error| TransferError::Io(error.error.to_string()))?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn verify_saved_snapshot_references(
    references: &[SavedSnapshotReference],
    rows: &[SerializedRow],
    destination_database: &Path,
    workspace: &Path,
) -> Result<(), TransferError> {
    let mounts = resolve_workspace_mounts(rows, &[], &[workspace.to_path_buf()])?;
    let mut keys = BTreeSet::new();
    for reference in references {
        let session = rows
            .iter()
            .find(|row| {
                row.table == "session"
                    && value_text(row, "id").ok().flatten().as_deref()
                        == Some(&reference.session_id)
            })
            .ok_or_else(|| {
                TransferError::Blocked(
                    "saved snapshot session is outside the selected graph".into(),
                )
            })?;
        let mount = mounts.get(&reference.session_id).ok_or_else(|| {
            TransferError::Blocked("saved snapshot workspace mapping is unavailable".into())
        })?;
        if required_text(session, "project_id")? != reference.project_id
            || hex::encode(sha1::Sha1::digest(
                mount.canonical_root.to_string_lossy().as_bytes(),
            )) != reference.worktree_sha1
            || reference.tree.len() != 40
            || !reference.tree.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !keys.insert((&reference.session_id, &reference.tree))
        {
            return Err(TransferError::Blocked(
                "saved snapshot identity differs from the exact native graph".into(),
            ));
        }
        match reference.availability {
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
                if reference.objects.is_empty() => {}
            SavedSnapshotAvailability::RetainedClosure if !reference.objects.is_empty() => {
                let bucket = destination_database
                    .parent()
                    .ok_or_else(|| {
                        TransferError::Blocked(
                            "snapshot destination has no provider datahome".into(),
                        )
                    })?
                    .join("snapshot")
                    .join(&reference.project_id)
                    .join(&reference.worktree_sha1);
                let stores = qualified_snapshot_stores(&bucket, &bucket.join("objects"))?;
                let closure =
                    read_snapshot_closure(&stores, &reference.tree)?.ok_or_else(|| {
                        TransferError::Blocked(
                            "retained snapshot is unavailable from the destination native store"
                                .into(),
                        )
                    })?;
                if closure.keys().collect::<BTreeSet<_>>()
                    != reference
                        .objects
                        .iter()
                        .map(|object| &object.object_id)
                        .collect::<BTreeSet<_>>()
                {
                    return Err(TransferError::Blocked(
                        "destination snapshot closure differs from retained objects".into(),
                    ));
                }
            }
            _ => {
                return Err(TransferError::Blocked(
                    "saved snapshot availability disagrees with its retained closure".into(),
                ))
            }
        }
    }
    Ok(())
}

fn decode_file_url(url: &str) -> Result<PathBuf, TransferError> {
    #[cfg(windows)]
    {
        return Ok(PathBuf::from(decode_windows_file_url_path(url)?));
    }

    #[cfg(not(windows))]
    {
        let path = PathBuf::from(decode_local_file_url_path(url)?);
        if !path.is_absolute() {
            return Err(TransferError::Blocked(
                "file URL must resolve to an absolute path".into(),
            ));
        }
        Ok(path)
    }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn decode_windows_file_url_path(url: &str) -> Result<String, TransferError> {
    let path = decode_local_file_url_path(url)?;
    let drive_path = path.strip_prefix('/').ok_or_else(|| {
        TransferError::Blocked("file URL must use a local absolute drive path".into())
    })?;
    let bytes = drive_path.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'/' {
        return Err(TransferError::Blocked(
            "Windows file URL must contain a drive-letter absolute path; UNC paths are unsupported"
                .into(),
        ));
    }
    Ok(drive_path.replace('/', "\\"))
}

fn decode_local_file_url_path(url: &str) -> Result<String, TransferError> {
    if url.contains('?') || url.contains('#') {
        return Err(TransferError::Blocked(
            "file URL query and fragment components are unsupported".into(),
        ));
    }
    let path = url
        .strip_prefix("file://")
        .ok_or_else(|| TransferError::Blocked("file URL is malformed".into()))?;
    let path = if let Some(rest) = path.strip_prefix("localhost/") {
        format!("/{rest}")
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        return Err(TransferError::Blocked(
            "file URL must use a local absolute path".into(),
        ));
    };
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(TransferError::Blocked(
                    "file URL has invalid escaping".into(),
                ));
            }
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            let (Some(high), Some(low)) = (high, low) else {
                return Err(TransferError::Blocked(
                    "file URL has invalid escaping".into(),
                ));
            };
            decoded.push(((high << 4) | low) as u8);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(decoded)
        .map_err(|_| TransferError::Blocked("file URL is not valid UTF-8".into()))?;
    Ok(path)
}

struct GitTreeInspection {
    identity: String,
    closure_bytes: u64,
    closure_sha256: String,
}

#[derive(PartialEq, Eq)]
struct GitRepository {
    work_tree: PathBuf,
    git_dir: PathBuf,
}

fn inspect_git_tree(mount: &Path, tree: &str) -> Result<GitTreeInspection, TransferError> {
    inspect_git_tree_with_costs(mount, tree, None)
}

fn inspect_git_tree_with_costs(
    mount: &Path,
    tree: &str,
    mut costs: Option<&mut SourceReaderCosts>,
) -> Result<GitTreeInspection, TransferError> {
    if !(tree.len() == 40 || tree.len() == 64) || !tree.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(TransferError::Blocked(
            "snapshot reference is not a supported content-addressed Git object ID".into(),
        ));
    }
    let mount = fs::canonicalize(mount).map_err(|error| {
        TransferError::Blocked(format!("exact workspace mount is unavailable: {error}"))
    })?;
    let qualified = qualify_workspace_git(&mount, &mut costs)?;
    let repository = &qualified.repository;
    let object_stores = &qualified.object_stores;
    let expected_id_length = if qualified.object_format == "sha1" {
        40
    } else {
        64
    };
    if tree.len() != expected_id_length {
        return Err(TransferError::Blocked(
            "snapshot object ID does not match the workspace Git format".into(),
        ));
    }
    let mut aggregate = workspace_metadata_aggregate();
    let initial = if aggregate {
        let observation = observe_workspace_git(&mount, &qualified, &[], &mut costs)?;
        aggregate = observation.is_some();
        observation
    } else {
        None
    };
    workspace_metadata_barrier("qualified", "");

    let mut objects = BTreeSet::new();
    let mut pending_trees = vec![tree.to_string()];
    let mut inspected_trees = BTreeSet::new();
    #[cfg(test)]
    let old_trees = workspace_metadata_test_hooks::STATE
        .with(|state| state.borrow().old_trees || state.borrow().legacy);
    #[cfg(not(test))]
    let old_trees = false;
    if let Some(initial) = initial.as_ref().filter(|_| !old_trees) {
        run_workspace_git_child(
            workspace_git_command(repository, &["cat-file", "--batch"]),
            &mut costs,
            |owner| {
                while let Some(current_tree) = pending_trees.pop() {
                    if !inspected_trees.insert(current_tree.clone()) {
                        continue;
                    }
                    workspace_metadata_barrier("tree_before", &current_tree);
                    let before = observe_workspace_git_filesystem(
                        &mount,
                        &qualified,
                        std::slice::from_ref(&current_tree),
                        &initial.config,
                    )?
                    .ok_or_else(workspace_changed)?;
                    if before.context != initial.filesystem.context {
                        return Err(workspace_changed());
                    }
                    // All edges stay provisional until both this owner and the
                    // independent final native census have settled successfully.
                    objects.insert(current_tree.clone());
                    owner.tree(&current_tree, expected_id_length, |object, is_tree| {
                        if is_tree {
                            pending_trees.push(object.clone());
                        }
                        objects.insert(object);
                    })?;
                    workspace_metadata_barrier("tree_after", &current_tree);
                    let after = observe_workspace_git_filesystem(
                        &mount,
                        &qualified,
                        std::slice::from_ref(&current_tree),
                        &initial.config,
                    )?
                    .ok_or_else(workspace_changed)?;
                    if before != after {
                        return Err(workspace_changed());
                    }
                }
                workspace_metadata_barrier("tree_close", "");
                owner.finish()?;
                workspace_metadata_barrier("tree_settled", "");
                Ok(())
            },
        )?;
    } else {
        // Visit each tree separately so its storage paths are checked before Git
        // reads it; recursive `ls-tree` could open unchecked descendant trees.
        while let Some(current_tree) = pending_trees.pop() {
            if !inspected_trees.insert(current_tree.clone()) {
                continue;
            }
            verify_git_loose_object_paths(
                &mount,
                object_stores,
                std::slice::from_ref(&current_tree),
            )?;
            let object_kind =
                git_text_in_repository(repository, &["cat-file", "-t", &current_tree], &mut costs)?;
            if object_kind.trim() != "tree" {
                return Err(TransferError::Blocked(
                    "snapshot reference does not identify a Git tree object".into(),
                ));
            }
            objects.insert(current_tree.clone());
            let entries = git_output_in_repository(
                repository,
                &["ls-tree", "-z", &current_tree],
                &mut costs,
            )?;
            for entry in entries
                .stdout
                .split(|byte| *byte == 0)
                .filter(|entry| !entry.is_empty())
            {
                let header_end = entry
                    .iter()
                    .position(|byte| *byte == b'\t')
                    .ok_or_else(|| {
                        TransferError::Blocked("Git tree contains an invalid entry".into())
                    })?;
                let header = std::str::from_utf8(&entry[..header_end]).map_err(|_| {
                    TransferError::Blocked("Git tree entry metadata is not UTF-8".into())
                })?;
                let fields: Vec<_> = header.split_whitespace().collect();
                if fields.len() != 3 {
                    return Err(TransferError::Blocked(
                        "snapshot tree contains an unsupported entry".into(),
                    ));
                }
                if fields[0] == "160000" && fields[1] == "commit" {
                    continue;
                }
                if !matches!(fields[1], "tree" | "blob") {
                    return Err(TransferError::Blocked(
                        "snapshot tree contains an unsupported object".into(),
                    ));
                }
                let object = fields[2].to_string();
                if fields[1] == "tree" {
                    pending_trees.push(object.clone());
                }
                objects.insert(object);
            }
        }
    }
    let referenced_objects = objects.iter().cloned().collect::<Vec<_>>();
    verify_git_loose_object_paths(&mount, object_stores, &referenced_objects)?;
    workspace_metadata_barrier("traversed", "");
    let before = if let Some(initial) = &initial {
        let current = qualify_workspace_git(&mount, &mut costs)?;
        let observation = observe_workspace_git(&mount, &current, &referenced_objects, &mut costs)?
            .ok_or_else(workspace_changed)?;
        if current != qualified
            || observation.filesystem.context != initial.filesystem.context
            || observation.config != initial.config
        {
            return Err(workspace_changed());
        }
        Some(observation)
    } else {
        None
    };
    workspace_metadata_barrier("precensus", "");
    let object_records =
        workspace_metadata_records(repository, &referenced_objects, aggregate, &mut costs)?;
    workspace_metadata_barrier("settled", "");
    if let Some(before) = before {
        let current = qualify_workspace_git(&mount, &mut costs)?;
        let after = observe_workspace_git(&mount, &current, &referenced_objects, &mut costs)?
            .ok_or_else(workspace_changed)?;
        if current != qualified || after != before {
            return Err(workspace_changed());
        }
    }
    let closure_bytes = object_records
        .iter()
        .fold(0_u64, |total, (_, _, size)| total.saturating_add(*size));
    #[cfg(test)]
    workspace_metadata_test_hooks::STATE
        .with(|state| state.borrow_mut().records = object_records.clone());
    let object_bytes = serde_json::to_vec(&object_records)
        .map_err(|error| TransferError::Serialization(error.to_string()))?;
    let common_relative = qualified
        .common_dir
        .strip_prefix(&mount)
        .map_err(|_| TransferError::Blocked("Git store escaped workspace mount".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    let identity = format!(
        "git:{}:{common_relative}:{}:{tree}",
        qualified.object_format,
        qualified.alternate_identity.join(",")
    );
    Ok(GitTreeInspection {
        identity,
        closure_bytes,
        closure_sha256: digest(&object_bytes),
    })
}

#[derive(PartialEq, Eq)]
struct QualifiedWorkspaceGit {
    repository: GitRepository,
    common_dir: PathBuf,
    object_format: String,
    object_stores: Vec<PathBuf>,
    alternate_identity: Vec<String>,
}

fn qualify_workspace_git(
    mount: &Path,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<QualifiedWorkspaceGit, TransferError> {
    let top_level = git_text_in_mount(mount, &["rev-parse", "--show-toplevel"], costs)?;
    let top_level = PathBuf::from(top_level.trim());
    let top_level = fs::canonicalize(top_level).map_err(|error| {
        TransferError::Blocked(format!("workspace Git root cannot be resolved: {error}"))
    })?;
    if top_level != mount {
        return Err(TransferError::Blocked(
            "snapshot Git root is not the exact managed workspace mount".into(),
        ));
    }
    let git_dir = git_path_in_mount(mount, "--absolute-git-dir", costs)?;
    if !git_dir.starts_with(mount) {
        return Err(TransferError::Blocked(
            "snapshot Git directory is outside the exact managed workspace mount".into(),
        ));
    }
    let repository = GitRepository {
        work_tree: mount.to_path_buf(),
        git_dir,
    };
    let common_dir = git_path_in_repository(&repository, "--git-common-dir", costs)?;
    let common_dir = if common_dir.is_absolute() {
        common_dir
    } else {
        mount.join(common_dir)
    };
    let common_dir = fs::canonicalize(common_dir).map_err(|error| {
        TransferError::Blocked(format!(
            "workspace Git common directory is unavailable: {error}"
        ))
    })?;
    if !repository.git_dir.starts_with(mount) || !common_dir.starts_with(mount) {
        return Err(TransferError::Blocked(
            "snapshot object store is outside the exact managed workspace mount".into(),
        ));
    }
    let object_format =
        git_text_in_repository(&repository, &["rev-parse", "--show-object-format"], costs)?
            .trim()
            .to_string();
    match object_format.as_str() {
        "sha1" | "sha256" => (),
        _ => {
            return Err(TransferError::Blocked(
                "workspace uses an unsupported Git object format".into(),
            ))
        }
    };
    let (object_stores, alternate_identity) = qualify_workspace_stores(mount, &common_dir)?;

    Ok(QualifiedWorkspaceGit {
        repository,
        common_dir,
        object_format,
        object_stores,
        alternate_identity,
    })
}

fn qualify_workspace_stores(
    mount: &Path,
    common_dir: &Path,
) -> Result<(Vec<PathBuf>, Vec<String>), TransferError> {
    let objects_dir =
        checked_git_store_directory(mount, &common_dir.join("objects"), "Git object directory")?;
    let mut object_stores = vec![objects_dir.clone()];
    let mut alternate_identity = Vec::new();
    if let Some(contents) = read_alternates_file_in_store(mount, &objects_dir)? {
        for line in contents.lines().filter(|line| !line.trim().is_empty()) {
            let candidate = PathBuf::from(line);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                objects_dir.join(candidate)
            };
            let candidate =
                checked_git_store_directory(mount, &candidate, "alternate Git object store")?;
            if read_alternates_file_in_store(mount, &candidate)?
                .is_some_and(|nested| nested.lines().any(|line| !line.trim().is_empty()))
            {
                return Err(TransferError::Blocked(
                    "nested Git object store alternates are unsupported".into(),
                ));
            }
            let relative = candidate.strip_prefix(mount).map_err(|_| {
                TransferError::Blocked(
                    "alternate Git object store is outside the exact managed workspace mount"
                        .into(),
                )
            })?;
            alternate_identity.push(relative.to_string_lossy().replace('\\', "/"));
            object_stores.push(candidate);
        }
    }
    // Git may consult any index in a store's pack directory, so check its
    // immediate entries once. Loose-object checks below stay limited to IDs
    // in this snapshot closure instead of walking a potentially large store.
    for object_store in &object_stores {
        inspect_git_pack_directory(mount, object_store)?;
    }

    Ok((object_stores, alternate_identity))
}

fn workspace_changed() -> TransferError {
    TransferError::Blocked(
        "workspace Git context or selected storage changed during inspection".into(),
    )
}

fn workspace_metadata_aggregate() -> bool {
    let enabled = cfg!(unix);
    #[cfg(test)]
    let enabled = enabled
        && workspace_metadata_test_hooks::STATE.with(|state| {
            let state = state.borrow();
            !state.fusion && !state.legacy
        });
    enabled
}

fn workspace_metadata_barrier(phase: &'static str, object: &str) {
    #[cfg(test)]
    workspace_metadata_test_hooks::STATE.with(|state| {
        if let Some(callback) = &mut state.borrow_mut().barrier {
            callback(phase, object);
        }
    });
    #[cfg(not(test))]
    let _ = (phase, object);
}

// This value belongs to one inspection. Absence and path bindings matter as
// much as selected files: a new earlier loose copy changes native resolution.
#[derive(PartialEq, Eq)]
struct WorkspaceGitObservation {
    filesystem: WorkspaceGitFilesystem,
    config: Vec<u8>,
}

#[derive(PartialEq, Eq)]
struct WorkspaceGitFilesystem {
    context: WorkspaceGitPaths,
    loose: WorkspaceGitPaths,
}

#[derive(Default, PartialEq, Eq)]
struct WorkspaceGitPaths {
    stamps: Vec<SnapshotStorageStamp>,
    absent: BTreeSet<PathBuf>,
    bindings: BTreeMap<PathBuf, WorkspaceGitPathBinding>,
}

#[derive(PartialEq, Eq)]
struct WorkspaceGitPathBinding {
    resolved: PathBuf,
    #[cfg(unix)]
    identity: (u64, u64, u32),
}

fn observe_workspace_bindings(
    path: &Path,
    bindings: &mut BTreeMap<PathBuf, WorkspaceGitPathBinding>,
) -> Result<(), TransferError> {
    for component in path.ancestors() {
        if bindings.contains_key(component) {
            break;
        }
        let metadata = match fs::symlink_metadata(component) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(not(unix))]
        let _ = metadata;
        bindings.insert(
            component.to_path_buf(),
            WorkspaceGitPathBinding {
                resolved: component.canonicalize()?,
                #[cfg(unix)]
                identity: (metadata.dev(), metadata.ino(), metadata.mode()),
            },
        );
    }
    Ok(())
}

const WORKSPACE_GIT_CONTEXT_BYTES: u64 = 16 * 1024 * 1024;

fn observe_workspace_path(
    path: &Path,
    contents: bool,
    stamps: &mut Vec<SnapshotStorageStamp>,
    absent: &mut BTreeSet<PathBuf>,
    bindings: &mut BTreeMap<PathBuf, WorkspaceGitPathBinding>,
) -> Result<(), TransferError> {
    observe_workspace_bindings(path, bindings)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            absent.insert(path.to_path_buf());
            return Ok(());
        }
        Err(error) => return Err(error.into()),
        Ok(_) => (),
    }
    let resolved = path.canonicalize()?;
    let before = snapshot_storage_stamp(path.to_path_buf(), None)?;
    let bytes = if contents && fs::metadata(path)?.is_file() {
        let mut bytes = Vec::new();
        File::open(path)?
            .take(WORKSPACE_GIT_CONTEXT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > WORKSPACE_GIT_CONTEXT_BYTES {
            return Err(TransferError::Blocked(
                "workspace Git context exceeds bounded observation".into(),
            ));
        }
        Some(
            String::from_utf8(bytes)
                .map_err(|_| TransferError::Blocked("workspace Git context is not UTF-8".into()))?,
        )
    } else {
        None
    };
    let mut after = snapshot_storage_stamp(path.to_path_buf(), None)?;
    if before != after || path.canonicalize()? != resolved {
        return Err(workspace_changed());
    }
    after.context_bytes = bytes;
    stamps.push(after);
    if resolved != path {
        stamps.push(snapshot_storage_stamp(resolved, None)?);
    }
    Ok(())
}

fn observe_workspace_git(
    mount: &Path,
    qualified: &QualifiedWorkspaceGit,
    objects: &[String],
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Option<WorkspaceGitObservation>, TransferError> {
    let repository = &qualified.repository;
    let config = workspace_git_config(repository, costs)?;
    let Some(filesystem) = observe_workspace_git_filesystem(mount, qualified, objects, &config)?
    else {
        return Ok(None);
    };
    if workspace_git_config(repository, costs)? != config {
        return Err(workspace_changed());
    }
    Ok(Some(WorkspaceGitObservation { filesystem, config }))
}

// The native config bytes describe the dependency inventory, never current
// proof. Every call reacquires all bindings, contents, absences and pack entries.
fn observe_workspace_git_filesystem(
    mount: &Path,
    qualified: &QualifiedWorkspaceGit,
    objects: &[String],
    config: &[u8],
) -> Result<Option<WorkspaceGitFilesystem>, TransferError> {
    let repository = &qualified.repository;
    let mut paths = BTreeMap::new();
    for path in [
        mount.to_path_buf(),
        mount.join(".git"),
        repository.git_dir.clone(),
        qualified.common_dir.clone(),
    ] {
        paths.insert(path, true);
    }
    for dir in [&repository.git_dir, &qualified.common_dir] {
        for name in ["config", "config.worktree", "commondir"] {
            paths.insert(dir.join(name), true);
        }
    }
    if !workspace_config_dependencies(config, mount, &mut paths)? {
        // The successful native enumeration identified a valid include whose
        // named-user expansion we cannot completely observe. Only initial
        // discovery may select fresh per-object children; later discovery is
        // context drift and callers refuse it without starting another census.
        return Ok(None);
    }
    let (stores, alternate_identity) = qualify_workspace_stores(mount, &qualified.common_dir)?;
    if stores != qualified.object_stores || alternate_identity != qualified.alternate_identity {
        return Err(workspace_changed());
    }
    for store in &qualified.object_stores {
        for path in [
            store.clone(),
            store.join("info"),
            store.join("info/alternates"),
            store.join("pack"),
        ] {
            paths.insert(path, true);
        }
        if store.join("pack").exists() {
            for entry in fs::read_dir(store.join("pack"))? {
                paths.insert(entry?.path(), false);
            }
        }
    }
    let mut observation = WorkspaceGitFilesystem {
        context: WorkspaceGitPaths::default(),
        loose: WorkspaceGitPaths::default(),
    };
    for (path, contents) in paths {
        observe_workspace_path(
            &path,
            contents,
            &mut observation.context.stamps,
            &mut observation.context.absent,
            &mut observation.context.bindings,
        )?;
    }
    let mut loose = BTreeSet::new();
    for store in &qualified.object_stores {
        for object in objects {
            let object = object.to_ascii_lowercase();
            loose.insert(store.join(&object[..2]));
            loose.insert(store.join(&object[..2]).join(&object[2..]));
        }
    }
    for path in loose {
        observe_workspace_path(
            &path,
            false,
            &mut observation.loose.stamps,
            &mut observation.loose.absent,
            &mut observation.loose.bindings,
        )?;
    }
    // Stable stamps do not qualify a newly present selected path. Reapply the
    // existing type and containment rules to the current store plan at both
    // pre-census and post-settlement acceptance, including preexisting fanouts.
    verify_git_loose_object_paths(mount, &qualified.object_stores, objects)?;
    Ok(Some(observation))
}

fn workspace_config_dependencies(
    config: &[u8],
    mount: &Path,
    paths: &mut BTreeMap<PathBuf, bool>,
) -> Result<bool, TransferError> {
    let fields = config.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.last() != Some(&&b""[..]) || (fields.len() - 1) % 2 != 0 {
        return Err(TransferError::Blocked(
            "invalid native Git configuration origins".into(),
        ));
    }
    let mut complete = true;
    for pair in fields[..fields.len() - 1].chunks_exact(2) {
        let origin = std::str::from_utf8(pair[0])
            .map_err(|_| TransferError::Blocked("Git configuration origin is not UTF-8".into()))?;
        let origin = origin.strip_prefix("file:").ok_or_else(|| {
            TransferError::Blocked("Git configuration origin is not a local file".into())
        })?;
        let origin = PathBuf::from(origin);
        let origin = if origin.is_absolute() {
            origin
        } else {
            mount.join(origin)
        };
        paths.insert(origin.clone(), true);
        let record = std::str::from_utf8(pair[1])
            .map_err(|_| TransferError::Blocked("Git configuration record is not UTF-8".into()))?;
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        if key == "include.path" || (key.starts_with("includeif.") && key.ends_with(".path")) {
            let dependency = if let Some(relative) = value.strip_prefix("~/") {
                PathBuf::from(std::env::var_os("HOME").ok_or_else(|| {
                    TransferError::Blocked("Git include home is unavailable".into())
                })?)
                .join(relative)
            } else if value.starts_with('~') {
                complete = false;
                continue;
            } else {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    path
                } else {
                    origin
                        .parent()
                        .ok_or_else(|| {
                            TransferError::Blocked("Git include origin has no parent".into())
                        })?
                        .join(path)
                }
            };
            paths.insert(dependency, true);
        }
    }
    Ok(complete)
}

fn workspace_git_command(repository: &GitRepository, arguments: &[&str]) -> Command {
    let mut command = sanitized_git_command();
    command
        .arg("--git-dir")
        .arg(&repository.git_dir)
        .arg("--work-tree")
        .arg(&repository.work_tree)
        .args(arguments);
    command
}

fn workspace_git_config(
    repository: &GitRepository,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Vec<u8>, TransferError> {
    run_workspace_git_child(
        workspace_git_command(
            repository,
            &["config", "--null", "--list", "--show-origin", "--includes"],
        ),
        costs,
        |owner| {
            owner.input.take();
            let mut bytes = Vec::new();
            (&mut owner.output)
                .take(WORKSPACE_GIT_CONTEXT_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > WORKSPACE_GIT_CONTEXT_BYTES {
                return Err(TransferError::Blocked(
                    "workspace Git configuration exceeds bounded observation".into(),
                ));
            }
            owner.finish()?;
            Ok(bytes)
        },
    )
}

fn workspace_metadata_records(
    repository: &GitRepository,
    objects: &[String],
    aggregate: bool,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Vec<(String, String, u64)>, TransferError> {
    let mut records = Vec::with_capacity(objects.len());
    #[cfg(test)]
    if workspace_metadata_test_hooks::STATE.with(|state| state.borrow().legacy) {
        for object in objects {
            let kind = git_text_in_repository(repository, &["cat-file", "-t", object], costs)?;
            let size = git_text_in_repository(repository, &["cat-file", "-s", object], costs)?
                .trim()
                .parse::<u64>()
                .map_err(|_| workspace_changed())?;
            records.push((object.clone(), kind.trim().to_string(), size));
        }
        return Ok(records);
    }
    let width = objects.first().map_or(40, String::len);
    if aggregate {
        #[cfg(test)]
        workspace_metadata_test_hooks::count("census_start");
        run_workspace_git_child(
            workspace_git_command(repository, &["cat-file", "--batch-check"]),
            costs,
            |owner| {
                for object in objects {
                    workspace_metadata_barrier("before_query", object);
                    let (kind, size) = owner.query(object, width)?;
                    records.push((object.clone(), kind, size));
                    workspace_metadata_barrier("after_query", object);
                }
                workspace_metadata_barrier(
                    "last_response",
                    objects.last().map_or("", String::as_str),
                );
                owner.finish()
            },
        )?;
    } else {
        for object in objects {
            #[cfg(test)]
            workspace_metadata_test_hooks::count("fusion_start");
            let (kind, size) = run_workspace_git_child(
                workspace_git_command(repository, &["cat-file", "--batch-check"]),
                costs,
                |owner| {
                    workspace_metadata_barrier("before_query", object);
                    let metadata = owner.query(object, width)?;
                    workspace_metadata_barrier("after_query", object);
                    owner.finish()?;
                    Ok(metadata)
                },
            )?;
            records.push((object.clone(), kind, size));
        }
    }
    Ok(records)
}

// Git normalizes modes to a type class; names remain opaque and are discarded.
// State is fixed size even for long modes/names, just like native tree decoding.
#[derive(Default)]
struct WorkspaceTreeParser {
    phase: u8,
    mode: u32,
    digits: bool,
    name: bool,
    oid: [u8; 32],
    oid_used: usize,
}

impl WorkspaceTreeParser {
    fn consume(
        &mut self,
        bytes: &[u8],
        width: usize,
        edge: &mut impl FnMut(String, bool),
    ) -> Result<(), TransferError> {
        for &byte in bytes {
            match self.phase {
                0 => {
                    if byte == b' ' && self.digits {
                        self.phase = 1;
                    } else if (b'0'..=b'7').contains(&byte) {
                        self.mode = self
                            .mode
                            .wrapping_shl(3)
                            .wrapping_add(u32::from(byte - b'0'));
                        self.digits = true;
                    } else {
                        return Err(TransferError::Blocked(
                            "malformed mode in workspace Git tree".into(),
                        ));
                    }
                }
                1 => {
                    if byte == 0 {
                        if !self.name {
                            return Err(TransferError::Blocked(
                                "empty filename in workspace Git tree".into(),
                            ));
                        }
                        self.phase = 2;
                    } else {
                        self.name = true;
                    }
                }
                _ => {
                    self.oid[self.oid_used] = byte;
                    self.oid_used += 1;
                    if self.oid_used == width {
                        let class = self.mode & 0o170000;
                        // Git normalizes every other mode class to an external
                        // commit. Preserve its raw tree bytes without following it.
                        if matches!(class, 0o040000 | 0o100000 | 0o120000) {
                            edge(hex::encode(&self.oid[..width]), class == 0o040000);
                        }
                        *self = Self::default();
                    }
                }
            }
        }
        Ok(())
    }
}

struct WorkspaceGitChild {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    stderr: Option<std::thread::JoinHandle<io::Result<Vec<u8>>>>,
    settled: bool,
}

fn run_workspace_git_child<T>(
    command: Command,
    costs: &mut Option<&mut SourceReaderCosts>,
    read: impl FnOnce(&mut WorkspaceGitChild) -> Result<T, TransferError>,
) -> Result<T, TransferError> {
    let started = Instant::now();
    let result = WorkspaceGitChild::from_command(command).and_then(|mut owner| read(&mut owner));
    if let Some(costs) = costs.as_deref_mut() {
        costs.workspace_git_command_starts = costs.workspace_git_command_starts.saturating_add(1);
        costs.workspace_git_command_us = costs
            .workspace_git_command_us
            .saturating_add(elapsed_us(started));
    }
    result
}

impl WorkspaceGitChild {
    fn from_command(mut command: Command) -> Result<Self, TransferError> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        #[cfg(test)]
        workspace_metadata_test_hooks::spawned(child.id());
        let input = child.stdin.take();
        let output = BufReader::new(child.stdout.take().expect("piped workspace Git stdout"));
        let mut stderr = child.stderr.take().expect("piped workspace Git stderr");
        #[cfg(not(test))]
        let (fail_start, fail_read) = (false, false);
        #[cfg(test)]
        let (fail_start, fail_read) = workspace_metadata_test_hooks::STATE.with(|state| {
            let state = state.borrow();
            (state.fail_drain_spawn, state.fail_drain_read)
        });
        #[cfg(test)]
        let fail_join =
            workspace_metadata_test_hooks::STATE.with(|state| state.borrow().fail_drain_join);
        #[cfg(all(test, target_os = "linux"))]
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let drain = if fail_start {
            Err(io::Error::other("injected workspace drainer spawn failure"))
        } else {
            std::thread::Builder::new()
                .name("workspace-git-stderr".into())
                .spawn(move || {
                    #[cfg(all(test, target_os = "linux"))]
                    started_tx
                        .send(unsafe { libc::syscall(libc::SYS_gettid) as u32 })
                        .expect("owned test drainer receiver");
                    let mut retained = Vec::new();
                    let mut bytes = [0; 8192];
                    loop {
                        let count = stderr.read(&mut bytes)?;
                        if count == 0 {
                            break;
                        }
                        if fail_read {
                            return Err(io::Error::other(
                                "injected workspace drainer read failure",
                            ));
                        }
                        let keep = count.min(16 * 1024 - retained.len());
                        retained.extend_from_slice(&bytes[..keep]);
                    }
                    #[cfg(test)]
                    assert!(!fail_join, "injected workspace drainer join failure");
                    Ok(retained)
                })
        };
        let stderr = match drain {
            Ok(drain) => drain,
            Err(error) => {
                drop(input);
                let _ = child.kill();
                let _ = child.wait();
                #[cfg(test)]
                workspace_metadata_test_hooks::count("reap");
                #[cfg(test)]
                workspace_metadata_test_hooks::count("all_reap");
                return Err(error.into());
            }
        };
        #[cfg(test)]
        workspace_metadata_test_hooks::count("drain_spawn");
        #[cfg(all(test, target_os = "linux"))]
        workspace_metadata_test_hooks::STATE.with(|state| {
            state
                .borrow_mut()
                .drainer_tids
                .push(started_rx.recv().expect("actual owned drainer start"))
        });
        Ok(Self {
            child,
            input,
            output,
            stderr: Some(stderr),
            settled: false,
        })
    }

    fn header(&mut self, object: &str, width: usize) -> Result<(String, u64), TransferError> {
        if object.len() != width
            || !(width == 40 || width == 64)
            || !object.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(TransferError::Blocked(
                "invalid workspace Git metadata request".into(),
            ));
        }
        let input = self.input.as_mut().ok_or_else(|| {
            TransferError::Blocked("workspace Git metadata input is unavailable".into())
        })?;
        writeln!(input, "{object}")?;
        input.flush()?;
        let mut header = Vec::new();
        loop {
            let mut byte = [0];
            self.output.read_exact(&mut byte)?;
            if byte[0] == b'\n' {
                break;
            }
            if header.len() == 256 {
                return Err(TransferError::Blocked(
                    "oversized workspace Git metadata header".into(),
                ));
            }
            header.push(byte[0]);
        }
        let header = std::str::from_utf8(&header)
            .map_err(|_| TransferError::Blocked("nontext workspace Git metadata header".into()))?;
        let fields = header.split(' ').collect::<Vec<_>>();
        if fields.len() != 3
            || fields[0].len() != width
            || !fields[0].bytes().all(|byte| byte.is_ascii_hexdigit())
            || !fields[0].eq_ignore_ascii_case(object)
            || !matches!(fields[1], "blob" | "tree" | "commit" | "tag")
            || fields[2].is_empty()
            || !fields[2].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(TransferError::Blocked(
                "invalid workspace Git metadata response".into(),
            ));
        }
        let size = fields[2]
            .parse::<u64>()
            .map_err(|_| TransferError::Blocked("invalid workspace Git object size".into()))?;
        Ok((fields[1].to_string(), size))
    }

    fn query(&mut self, object: &str, width: usize) -> Result<(String, u64), TransferError> {
        let metadata = self.header(object, width)?;
        if !self.output.buffer().is_empty() {
            return Err(TransferError::Blocked(
                "unsolicited workspace Git metadata output".into(),
            ));
        }
        Ok(metadata)
    }

    fn tree(
        &mut self,
        object: &str,
        width: usize,
        mut edge: impl FnMut(String, bool),
    ) -> Result<(), TransferError> {
        #[cfg(test)]
        workspace_metadata_test_hooks::count("tree_query");
        let (kind, size) = self.header(object, width)?;
        if kind != "tree" {
            return Err(TransferError::Blocked(
                "snapshot reference does not identify a Git tree object".into(),
            ));
        }
        let canonical = format!("tree {size}\0");
        let mut sha1 = sha1::Sha1::new();
        let mut sha256 = Sha256::new();
        if width == 40 {
            sha1.update(canonical.as_bytes());
        } else {
            sha256.update(canonical.as_bytes());
        }
        let mut parser = WorkspaceTreeParser::default();
        let mut remaining = size;
        let mut buffer = [0; PAYLOAD_WRITE_BUFFER_BYTES];
        while remaining != 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            self.output.read_exact(&mut buffer[..count])?;
            if width == 40 {
                sha1.update(&buffer[..count]);
            } else {
                sha256.update(&buffer[..count]);
            }
            parser.consume(&buffer[..count], width / 2, &mut edge)?;
            remaining -= count as u64;
        }
        let mut newline = [0];
        self.output.read_exact(&mut newline)?;
        let hash = if width == 40 {
            hex::encode(sha1.finalize())
        } else {
            hex::encode(sha256.finalize())
        };
        if newline != [b'\n']
            || parser.phase != 0
            || parser.digits
            || !hash.eq_ignore_ascii_case(object)
        {
            return Err(TransferError::Blocked(
                "invalid workspace Git tree body or identity".into(),
            ));
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), TransferError> {
        self.input.take();
        let mut trailing = false;
        let mut bytes = [0; 8192];
        loop {
            let count = self.output.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            trailing = true;
        }
        let status = self.child.wait()?;
        self.settled = true;
        #[cfg(test)]
        workspace_metadata_test_hooks::count("reap");
        #[cfg(test)]
        workspace_metadata_test_hooks::count("all_reap");
        let stderr = self
            .stderr
            .take()
            .expect("owned workspace stderr drainer")
            .join();
        #[cfg(test)]
        workspace_metadata_test_hooks::count("drain_join");
        let _stderr = stderr
            .map_err(|_| TransferError::Blocked("workspace Git stderr drainer failed".into()))??;
        #[cfg(test)]
        workspace_metadata_test_hooks::STATE
            .with(|state| state.borrow_mut().retained_stderr = _stderr.len());
        if trailing || !status.success() {
            return Err(TransferError::Blocked(
                "workspace Git process returned late output or unsuccessful status".into(),
            ));
        }
        Ok(())
    }
}

impl Drop for WorkspaceGitChild {
    fn drop(&mut self) {
        self.input.take();
        if !self.settled {
            let _ = self.child.kill();
            let _ = self.child.wait();
            #[cfg(test)]
            workspace_metadata_test_hooks::count("reap");
            #[cfg(test)]
            workspace_metadata_test_hooks::count("all_reap");
        }
        if let Some(stderr) = self.stderr.take() {
            let result = stderr.join();
            #[cfg(test)]
            {
                workspace_metadata_test_hooks::count("drain_join");
                if let Ok(Ok(bytes)) = result {
                    workspace_metadata_test_hooks::STATE
                        .with(|state| state.borrow_mut().retained_stderr = bytes.len());
                }
            }
            #[cfg(not(test))]
            let _ = result;
        }
    }
}

#[cfg(test)]
mod workspace_metadata_test_hooks {
    use super::*;
    use std::cell::RefCell;
    type Barrier = Box<dyn FnMut(&'static str, &str)>;
    #[derive(Default)]
    pub(super) struct State {
        pub fusion: bool,
        pub legacy: bool,
        pub old_trees: bool,
        pub records: Vec<(String, String, u64)>,
        pub barrier: Option<Barrier>,
        pub counts: BTreeMap<&'static str, usize>,
        pub owned_pids: Vec<u32>,
        pub retained_stderr: usize,
        pub fail_drain_spawn: bool,
        pub fail_drain_read: bool,
        pub fail_drain_join: bool,
        #[cfg(target_os = "linux")]
        pub drainer_tids: Vec<u32>,
    }
    thread_local! { pub(super) static STATE: RefCell<State> = RefCell::new(State::default()); }
    pub(super) fn spawned(pid: u32) {
        STATE.with(|state| state.borrow_mut().owned_pids.push(pid));
        count("spawn");
        process_spawned(pid);
    }
    pub(super) fn process_spawned(pid: u32) {
        count("all_spawn");
        #[cfg(target_os = "linux")]
        {
            let tid = unsafe { libc::syscall(libc::SYS_gettid) };
            let children = fs::read_to_string(format!("/proc/self/task/{tid}/children"))
                .expect("owned test thread children");
            let mut workspace = 0;
            let mut bodies = 0;
            let mut pipes = 0;
            for candidate in children
                .split_whitespace()
                .map(|value| value.parse::<u32>().unwrap())
            {
                let args = fs::read(format!("/proc/{candidate}/cmdline")).unwrap_or_default();
                let body = args.split(|byte| *byte == 0).any(|arg| arg == b"--batch");
                if candidate == pid {
                    workspace += 1;
                } else if body {
                    bodies += 1;
                } else {
                    continue;
                }
                if let Ok(entries) = fs::read_dir(format!("/proc/{candidate}/fd")) {
                    pipes += entries
                        .filter_map(Result::ok)
                        .filter_map(|entry| fs::read_link(entry.path()).ok())
                        .filter(|target| target.to_string_lossy().starts_with("pipe:"))
                        .count();
                }
            }
            STATE.with(|state| {
                let mut state = state.borrow_mut();
                for (key, measured) in [
                    ("os_workspace_peak", workspace),
                    ("os_body_peak", bodies),
                    ("os_process_peak", workspace + bodies),
                    ("os_pipe_peak", pipes),
                ] {
                    let maximum = state.counts.entry(key).or_default();
                    *maximum = (*maximum).max(measured);
                }
            });
        }
    }
    pub(super) fn count(operation: &'static str) {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            *state.counts.entry(operation).or_default() += 1;
            for (spawn, reap, peak) in [
                ("spawn", "reap", "peak"),
                ("drain_spawn", "drain_join", "drain_peak"),
                ("all_spawn", "all_reap", "all_peak"),
            ] {
                let live = state.counts.get(spawn).copied().unwrap_or(0)
                    - state.counts.get(reap).copied().unwrap_or(0);
                let peak = state.counts.entry(peak).or_default();
                *peak = (*peak).max(live);
            }
        });
    }
}

fn read_alternates_file(path: &Path) -> Result<Option<String>, TransferError> {
    let metadata = match snapshot_symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(TransferError::Blocked(format!(
                "Git alternate metadata is unavailable: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(TransferError::Blocked(
            "Git alternate metadata is not a regular file".into(),
        ));
    }
    snapshot_read_context(path).map(Some).map_err(|error| {
        TransferError::Blocked(format!("Git alternate metadata cannot be read: {error}"))
    })
}

fn checked_git_store_directory(
    mount: &Path,
    path: &Path,
    label: &str,
) -> Result<PathBuf, TransferError> {
    checked_git_storage_path(mount, path, label, true)?
        .ok_or_else(|| TransferError::Blocked(format!("{label} is unavailable")))
}

// Native storage needs both a guarded binding and its lexical stamp. On
// exact paths the final lstat proves kind and supplies that stamp, so another
// resolved stat is redundant. Redirected-but-contained components retain the
// independent resolved-kind check and lexical stamp.
fn observe_git_storage_path(
    mount: &Path,
    path: &Path,
    label: &str,
    expect_directory: bool,
) -> Result<Option<SnapshotObservedPath>, TransferError> {
    let metadata = match snapshot_symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(TransferError::Blocked(format!(
                "{label} is unavailable: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(TransferError::Blocked(format!(
            "{label} is a symbolic link"
        )));
    }
    let canonical = snapshot_canonicalize(path)
        .map_err(|error| TransferError::Blocked(format!("{label} cannot be resolved: {error}")))?;
    if !canonical.starts_with(mount) {
        return Err(TransferError::Blocked(format!(
            "{label} is outside the exact managed workspace mount"
        )));
    }
    let resolved =
        if canonical == path {
            None
        } else {
            Some(snapshot_resolved_metadata(&canonical).map_err(|error| {
                TransferError::Blocked(format!("{label} is unavailable: {error}"))
            })?)
        };
    #[cfg(test)]
    snapshot_reuse_test_hooks::observation_barrier("pack_binding", path);
    let current = snapshot_symlink_metadata(path)?;
    if !snapshot_metadata_matches(&metadata, &current) {
        return Err(TransferError::Blocked(format!(
            "{label} changed during its current observation"
        )));
    }
    let kind_metadata = resolved.as_ref().unwrap_or(&current);
    check_git_storage_kind(kind_metadata, label, expect_directory)?;
    Ok(Some(SnapshotObservedPath {
        path: path.to_path_buf(),
        canonical,
        metadata: current,
    }))
}

fn check_git_storage_kind(
    metadata: &fs::Metadata,
    label: &str,
    expect_directory: bool,
) -> Result<(), TransferError> {
    let expected_type_matches = if expect_directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if expected_type_matches {
        return Ok(());
    }
    Err(TransferError::Blocked(format!(
        "{label} is not a {}",
        if expect_directory {
            "directory"
        } else {
            "regular file"
        }
    )))
}

fn checked_git_storage_path(
    mount: &Path,
    path: &Path,
    label: &str,
    expect_directory: bool,
) -> Result<Option<PathBuf>, TransferError> {
    let metadata = match snapshot_symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(TransferError::Blocked(format!(
                "{label} is unavailable: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(TransferError::Blocked(format!(
            "{label} is a symbolic link"
        )));
    }
    let canonical = snapshot_canonicalize(path)
        .map_err(|error| TransferError::Blocked(format!("{label} cannot be resolved: {error}")))?;
    if !canonical.starts_with(mount) {
        return Err(TransferError::Blocked(format!(
            "{label} is outside the exact managed workspace mount"
        )));
    }
    let resolved_metadata = snapshot_resolved_metadata(&canonical)
        .map_err(|error| TransferError::Blocked(format!("{label} is unavailable: {error}")))?;
    check_git_storage_kind(&resolved_metadata, label, expect_directory)?;
    Ok(Some(canonical))
}

fn read_alternates_file_in_store(
    mount: &Path,
    objects_dir: &Path,
) -> Result<Option<String>, TransferError> {
    let Some(info_dir) = checked_git_storage_path(
        mount,
        &objects_dir.join("info"),
        "Git object info directory",
        true,
    )?
    else {
        return Ok(None);
    };
    read_alternates_file(&info_dir.join("alternates"))
}

fn inspect_git_pack_directory(mount: &Path, objects_dir: &Path) -> Result<(), TransferError> {
    let Some(pack_dir) =
        checked_git_storage_path(mount, &objects_dir.join("pack"), "Git pack directory", true)?
    else {
        return Ok(());
    };
    let entries = fs::read_dir(&pack_dir).map_err(|error| {
        TransferError::Blocked(format!("Git pack directory cannot be read: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            TransferError::Blocked(format!("Git pack directory cannot be read: {error}"))
        })?;
        checked_git_storage_path(mount, &entry.path(), "Git pack file", false)?;
    }
    Ok(())
}

fn verify_git_loose_object_paths(
    mount: &Path,
    object_stores: &[PathBuf],
    object_ids: &[String],
) -> Result<(), TransferError> {
    for objects_dir in object_stores {
        for object_id in object_ids {
            if !(object_id.len() == 40 || object_id.len() == 64)
                || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(TransferError::Blocked(
                    "Git returned an invalid object ID".into(),
                ));
            }
            let object_id = object_id.to_ascii_lowercase();
            let fanout = objects_dir.join(&object_id[..2]);
            let Some(fanout_dir) = checked_git_storage_path(
                mount,
                &fanout,
                "Git loose-object fanout directory",
                true,
            )?
            else {
                continue;
            };
            checked_git_storage_path(
                mount,
                &fanout_dir.join(&object_id[2..]),
                "Git loose object file",
                false,
            )?;
        }
    }
    Ok(())
}

fn git_path_in_mount(
    mount: &Path,
    argument: &str,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<PathBuf, TransferError> {
    let path = PathBuf::from(git_text_in_mount(mount, &["rev-parse", argument], costs)?.trim());
    if path.is_absolute() {
        fs::canonicalize(path).map_err(|error| {
            TransferError::Blocked(format!("workspace Git path is unavailable: {error}"))
        })
    } else {
        fs::canonicalize(mount.join(path)).map_err(|error| {
            TransferError::Blocked(format!("workspace Git path is unavailable: {error}"))
        })
    }
}

fn git_path_in_repository(
    repository: &GitRepository,
    argument: &str,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<PathBuf, TransferError> {
    let path =
        PathBuf::from(git_text_in_repository(repository, &["rev-parse", argument], costs)?.trim());
    if path.is_absolute() {
        fs::canonicalize(path).map_err(|error| {
            TransferError::Blocked(format!("workspace Git path is unavailable: {error}"))
        })
    } else {
        fs::canonicalize(repository.work_tree.join(path)).map_err(|error| {
            TransferError::Blocked(format!("workspace Git path is unavailable: {error}"))
        })
    }
}

fn git_text_in_mount(
    mount: &Path,
    arguments: &[&str],
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<String, TransferError> {
    let output = git_output_in_mount(mount, arguments, costs)?;
    String::from_utf8(output.stdout)
        .map_err(|_| TransferError::Blocked("Git returned non-UTF-8 metadata".into()))
}

fn git_text_in_repository(
    repository: &GitRepository,
    arguments: &[&str],
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<String, TransferError> {
    let output = git_output_in_repository(repository, arguments, costs)?;
    String::from_utf8(output.stdout)
        .map_err(|_| TransferError::Blocked("Git returned non-UTF-8 metadata".into()))
}

fn git_output_in_mount(
    mount: &Path,
    arguments: &[&str],
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Output, TransferError> {
    let mut command = sanitized_git_command();
    command.arg("-C").arg(mount).args(arguments);
    checked_git_output(command, costs)
}

fn git_output_in_repository(
    repository: &GitRepository,
    arguments: &[&str],
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Output, TransferError> {
    checked_git_output(workspace_git_command(repository, arguments), costs)
}

fn sanitized_git_command() -> Command {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    command.env("GIT_CONFIG_GLOBAL", "NUL");
    #[cfg(not(windows))]
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");
    command
}

fn checked_git_output(
    mut command: Command,
    costs: &mut Option<&mut SourceReaderCosts>,
) -> Result<Output, TransferError> {
    let started = Instant::now();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.spawn().and_then(|child| {
        #[cfg(test)]
        workspace_metadata_test_hooks::process_spawned(child.id());
        let output = child.wait_with_output();
        #[cfg(test)]
        workspace_metadata_test_hooks::count("all_reap");
        output
    });
    if let Some(costs) = costs.as_deref_mut() {
        // A start is an attempt, including failure to spawn an OS child.
        costs.workspace_git_command_starts = costs.workspace_git_command_starts.saturating_add(1);
        costs.workspace_git_command_us = costs
            .workspace_git_command_us
            .saturating_add(elapsed_us(started));
    }
    let output = output.map_err(|error| {
        TransferError::Blocked(format!("local Git object-store check failed: {error}"))
    })?;
    if !output.status.success() {
        return Err(TransferError::Blocked(format!(
            "local Git object-store check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output)
}

fn resolve_exact_source(
    inventory: &HostOpenCodeInventory,
    session_id: &str,
) -> Result<PathBuf, TransferError> {
    let candidates = inventory.candidates()?;
    let mut matches = Vec::new();
    for path in candidates {
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            TransferError::Blocked(format!("source database is unavailable: {error}"))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(TransferError::Blocked(
                "source database path is a symbolic link".into(),
            ));
        }
        if !metadata.is_file() {
            return Err(TransferError::Blocked(
                "source database path is not a regular file".into(),
            ));
        }
        let connection = open_source_read_only(&path)?;
        let has_session: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1)",
                [session_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                TransferError::Blocked(format!(
                    "source database cannot prove the exact session: {error}"
                ))
            })?;
        if has_session {
            matches.push(path);
        }
    }
    match matches.as_slice() {
        [path] => Ok(path.clone()),
        [] => Err(TransferError::Blocked(
            "no trusted source store contains the exact native session".into(),
        )),
        _ => Err(TransferError::Blocked(
            "multiple trusted source stores contain the exact native session".into(),
        )),
    }
}

fn open_source_read_only(path: &Path) -> Result<Connection, TransferError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| TransferError::Blocked(format!("source database cannot be read: {error}")))?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

#[cfg(test)]
fn create_online_backup(source: &Connection, destination: &Path) -> Result<(), TransferError> {
    create_observed_online_backup(source, destination, &ExportOptions::default())
}

fn create_observed_online_backup(
    source: &Connection,
    destination: &Path,
    options: &ExportOptions,
) -> Result<(), TransferError> {
    options.run_phase("backup", None, "pages", |phase| {
        create_online_backup_with_progress(source, destination, |progress| {
            phase.progress(
                progress.pagecount.saturating_sub(progress.remaining).max(0) as u64,
                Some(progress.pagecount.max(0) as u64),
            );
            Ok(())
        })
    })
}

fn create_online_backup_with_progress(
    source: &Connection,
    destination: &Path,
    mut progress: impl FnMut(Progress) -> Result<(), TransferError>,
) -> Result<(), TransferError> {
    // BEGIN alone is deferred: read main before starting the incremental
    // backup so other connections cannot restart it with every new commit.
    // WAL writers keep committing against this fixed snapshot. Rollback
    // journals retain SQLite's normal read lock until the copy completes.
    let read_transaction = source.unchecked_transaction()?;
    read_transaction.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))?;
    let mut target = Connection::open(destination)?;
    let backup = Backup::new(&read_transaction, &mut target)?;
    let mut last_progress = Instant::now();
    loop {
        let result = backup.step(2048).map_err(|error| {
            TransferError::Blocked(format!("consistent SQLite snapshot failed: {error}"))
        })?;
        progress(backup.progress())?;
        match result {
            StepResult::Done => break,
            StepResult::More => last_progress = Instant::now(),
            StepResult::Busy | StepResult::Locked => {
                if last_progress.elapsed() >= Duration::from_secs(5) {
                    return Err(TransferError::Blocked(
                        "consistent SQLite snapshot remained locked without progress".into(),
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => {
                return Err(TransferError::Blocked(
                    "unknown SQLite backup result".into(),
                ))
            }
        }
    }
    drop(backup);
    read_transaction.rollback()?;
    // The new private copy must not retain WAL mode: SQLite's root reader
    // reasserts WAL ownership on open, changing ctime even without a write.
    // Stabilize only this extraction-owned database before it is qualified;
    // all later database and sidecar identity fences remain intact.
    let journal_mode: String =
        target.query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))?;
    if journal_mode != "delete" {
        return Err(TransferError::Blocked(
            "private SQLite snapshot journal mode could not be stabilized".into(),
        ));
    }
    Ok(())
}

fn prepare_extraction_root(path: &Path) -> Result<PathBuf, TransferError> {
    let newly_created = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(TransferError::Blocked(
                    "private extraction root is not a real directory".into(),
                ));
            }
            false
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                fs::create_dir_all(path)?;
                true
            }
            #[cfg(windows)]
            {
                windows_acl::create_private_directory(path)?;
                true
            }
            #[cfg(not(any(unix, windows)))]
            {
                return Err(TransferError::Blocked(
                    "private extraction roots are unsupported on this platform".into(),
                ));
            }
        }
        Err(error) => return Err(error.into()),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if newly_created {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
        let metadata = fs::metadata(path)?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(TransferError::Blocked(
                "private extraction root has broad permissions".into(),
            ));
        }
    }
    #[cfg(windows)]
    {
        let _ = newly_created;
        let evidence = windows_acl::read_acl_evidence(path)?;
        if !windows_acl_is_private(&evidence) {
            return Err(TransferError::Blocked(
                "Windows extraction root ACL is not restricted to the current user".into(),
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = newly_created;
    Ok(path.to_path_buf())
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowsAclEvidence {
    owner_is_current_user: bool,
    dacl_present: bool,
    dacl_protected: bool,
    ace_count: usize,
    current_user_has_full_access: bool,
    all_children_inherit_current_user_access: bool,
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn windows_acl_is_private(evidence: &WindowsAclEvidence) -> bool {
    evidence.owner_is_current_user
        && evidence.dacl_present
        && evidence.dacl_protected
        && evidence.ace_count == 1
        && evidence.current_user_has_full_access
        && evidence.all_children_inherit_current_user_access
}

#[cfg(windows)]
mod windows_acl {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{addr_of, null_mut};
    use std::slice;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation, TokenUser,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateDirectoryW, FILE_ALL_ACCESS};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    use super::{TransferError, WindowsAclEvidence};

    struct TokenHandle(HANDLE);

    impl Drop for TokenHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0 as HLOCAL);
            }
        }
    }

    pub(super) fn create_private_directory(path: &Path) -> Result<(), TransferError> {
        let current_user_sid = current_user_sid()?;
        let sid_string = sid_to_string(&current_user_sid)?;
        let sddl = format!("D:P(A;OICI;FA;;;{sid_string})");
        create_directory_with_sddl(path, &sddl).map(|_| ())
    }

    fn create_directory_with_sddl(path: &Path, sddl: &str) -> Result<bool, TransferError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                TransferError::Blocked(format!(
                    "Windows extraction root parent is unavailable: {error}"
                ))
            })?;
        }
        let descriptor = security_descriptor(sddl)?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let created = unsafe { CreateDirectoryW(path.as_ptr(), &mut attributes) };
        if created != 0 {
            return Ok(true);
        }
        let error = unsafe { GetLastError() };
        if error == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS {
            return Ok(false);
        }
        Err(TransferError::Blocked(format!(
            "Windows could not create a private extraction root (error {error})"
        )))
    }

    pub(super) fn read_acl_evidence(path: &Path) -> Result<WindowsAclEvidence, TransferError> {
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut owner: PSID = null_mut();
        let mut dacl = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let error = unsafe {
            GetNamedSecurityInfoW(
                path.as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if error != 0 {
            return Err(TransferError::Blocked(format!(
                "Windows extraction root ACL cannot be read (error {error})"
            )));
        }
        let descriptor = LocalSecurityDescriptor(descriptor);
        let current_user_sid = current_user_sid()?;
        let owner_is_current_user =
            unsafe { !owner.is_null() && EqualSid(owner, current_user_sid.as_ptr() as PSID) != 0 };

        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
            return Err(TransferError::Blocked(
                "Windows extraction root ACL control flags cannot be read".into(),
            ));
        }
        let mut dacl_present = 0;
        let mut queried_dacl = null_mut();
        let mut dacl_defaulted = 0;
        if unsafe {
            GetSecurityDescriptorDacl(
                descriptor.0,
                &mut dacl_present,
                &mut queried_dacl,
                &mut dacl_defaulted,
            )
        } == 0
        {
            return Err(TransferError::Blocked(
                "Windows extraction root DACL cannot be read".into(),
            ));
        }

        let mut ace_count = 0usize;
        let mut current_user_has_full_access = false;
        let mut all_children_inherit_current_user_access = false;
        if dacl_present != 0 && !queried_dacl.is_null() {
            let mut acl_info = ACL_SIZE_INFORMATION::default();
            if unsafe {
                GetAclInformation(
                    queried_dacl,
                    &mut acl_info as *mut _ as *mut c_void,
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            } == 0
            {
                return Err(TransferError::Blocked(
                    "Windows extraction root access list cannot be read".into(),
                ));
            }
            ace_count = acl_info.AceCount as usize;
            if ace_count == 1 {
                let mut ace_pointer: *mut c_void = null_mut();
                if unsafe { GetAce(queried_dacl, 0, &mut ace_pointer) } != 0
                    && !ace_pointer.is_null()
                {
                    let header = unsafe { *(ace_pointer as *const ACE_HEADER) };
                    if header.AceType == 0 {
                        let ace = unsafe { &*(ace_pointer as *const ACCESS_ALLOWED_ACE) };
                        let ace_sid = addr_of!(ace.SidStart) as PSID;
                        current_user_has_full_access = unsafe {
                            EqualSid(ace_sid, current_user_sid.as_ptr() as PSID) != 0
                                && ace.Mask == FILE_ALL_ACCESS
                        };
                        all_children_inherit_current_user_access = u32::from(header.AceFlags)
                            == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE);
                    }
                }
            }
        }

        Ok(WindowsAclEvidence {
            owner_is_current_user,
            dacl_present: dacl_present != 0 && !queried_dacl.is_null(),
            dacl_protected: control & SE_DACL_PROTECTED != 0,
            ace_count,
            current_user_has_full_access,
            all_children_inherit_current_user_access,
        })
    }

    fn current_user_sid() -> Result<Vec<u8>, TransferError> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(TransferError::Blocked(
                "Windows current-user identity cannot be read".into(),
            ));
        }
        let token = TokenHandle(token);
        let mut required = 0u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(TransferError::Blocked(
                "Windows current-user identity has no user SID".into(),
            ));
        }
        let mut buffer = vec![0u8; required as usize];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                required,
                &mut required,
            )
        } == 0
        {
            return Err(TransferError::Blocked(
                "Windows current-user SID cannot be read".into(),
            ));
        }
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        if user.User.Sid.is_null() {
            return Err(TransferError::Blocked(
                "Windows current-user token has no user SID".into(),
            ));
        }
        let length = unsafe { GetLengthSid(user.User.Sid) } as usize;
        if length == 0 {
            return Err(TransferError::Blocked(
                "Windows current-user SID has an invalid length".into(),
            ));
        }
        Ok(unsafe { slice::from_raw_parts(user.User.Sid as *const u8, length) }.to_vec())
    }

    fn sid_to_string(sid: &[u8]) -> Result<String, TransferError> {
        let mut pointer = null_mut();
        if unsafe { ConvertSidToStringSidW(sid.as_ptr() as PSID, &mut pointer) } == 0 {
            return Err(TransferError::Blocked(
                "Windows current-user SID cannot be formatted".into(),
            ));
        }
        let mut length = 0;
        unsafe {
            while *pointer.add(length) != 0 {
                length += 1;
            }
        }
        let value = unsafe { String::from_utf16_lossy(slice::from_raw_parts(pointer, length)) };
        unsafe {
            LocalFree(pointer as HLOCAL);
        }
        Ok(value)
    }

    fn security_descriptor(sddl: &str) -> Result<LocalSecurityDescriptor, TransferError> {
        let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(TransferError::Blocked(
                "Windows private extraction ACL could not be created".into(),
            ));
        }
        Ok(LocalSecurityDescriptor(descriptor))
    }

    #[cfg(test)]
    pub(super) fn create_test_directory_with_world_access(
        path: &Path,
    ) -> Result<(), TransferError> {
        if create_directory_with_sddl(path, "D:P(A;OICI;FA;;;WD)")? {
            Ok(())
        } else {
            Err(TransferError::Blocked(
                "test extraction directory unexpectedly exists".into(),
            ))
        }
    }
}

fn write_owner_pid(directory: &Path) -> Result<(), TransferError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(".owner-pid"))?;
    write!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(())
}

/// Remove only stale extraction directories owned by this exporter. Active
/// process directories and unrelated files under the caller's temp root are
/// left untouched.
pub fn recover_interrupted_extractions(root: &Path) -> Result<usize, TransferError> {
    let root = prepare_extraction_root(root)?;
    let mut removed = 0;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(EXTRACT_DIR_PREFIX) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let named_owner = name
            .to_string_lossy()
            .strip_prefix(EXTRACT_DIR_PREFIX)
            .and_then(|suffix| suffix.split('-').next())
            .and_then(|value| value.parse::<u32>().ok());
        let owner_path = entry.path().join(".owner-pid");
        let recorded_owner = fs::read_to_string(&owner_path)
            .ok()
            .and_then(|value| value.parse::<u32>().ok());
        if named_owner.is_some_and(process_is_running)
            || recorded_owner.is_some_and(process_is_running)
        {
            continue;
        }
        fs::remove_dir_all(entry.path())?;
        removed += 1;
    }
    Ok(removed)
}

fn process_is_running(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        if pid > libc::pid_t::MAX as u32 {
            return false;
        }
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;

        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const ERROR_INVALID_PARAMETER: u32 = 87;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            #[link_name = "OpenProcess"]
            fn open_process(
                desired_access: u32,
                inherit_handle: i32,
                process_id: u32,
            ) -> *mut c_void;
            #[link_name = "GetLastError"]
            fn get_last_error() -> u32;
            #[link_name = "CloseHandle"]
            fn close_handle(handle: *mut c_void) -> i32;
        }

        unsafe {
            let handle = open_process(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                get_last_error() != ERROR_INVALID_PARAMETER
            } else {
                close_handle(handle);
                true
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        // Unknown platforms cannot prove that an owner has exited. Keep its
        // extraction directory rather than risk deleting a live export.
        true
    }
}

fn remove_snapshot_files(snapshot: &Path) -> Result<(), TransferError> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = if suffix.is_empty() {
            snapshot.to_path_buf()
        } else {
            PathBuf::from(format!("{}{}", snapshot.display(), suffix))
        };
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn validate_known_schema(connection: &Connection) -> Result<(), TransferError> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let actual: BTreeSet<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    for required in REQUIRED_TABLES {
        if !actual.contains(*required) {
            return Err(TransferError::Blocked(format!(
                "pinned OpenCode schema is missing the {required} table"
            )));
        }
    }
    for table in &actual {
        if !REQUIRED_TABLES.contains(&table.as_str()) && !OMITTABLE_TABLES.contains(&table.as_str())
        {
            return Err(TransferError::Blocked(format!(
                "source schema contains an unrecognized table: {table}"
            )));
        }
    }
    for table in ["message_seq", "provider_config"] {
        if actual.contains(table) {
            let expected: &[&str] = if table == "message_seq" {
                &["session_id", "next"]
            } else {
                &["id", "value"]
            };
            let actual_columns = table_columns(connection, table)?;
            if actual_columns
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                != expected
            {
                return Err(TransferError::Blocked(format!(
                    "known synthetic table {table} has an unrecognized shape"
                )));
            }
        }
    }
    if table_columns(connection, "migration")? != ["id", "time_completed"] {
        return Err(TransferError::Blocked(
            "source migration journal has an unrecognized shape".into(),
        ));
    }
    if table_columns(connection, "data_migration")? != ["name", "time_completed"] {
        return Err(TransferError::Blocked(
            "source data-migration journal has an unrecognized shape".into(),
        ));
    }
    qualify_schema_relationships(
        connection,
        actual.contains("message_seq"),
        actual.contains("provider_config"),
    )?;
    Ok(())
}

/// Qualify only the pinned SQLite schema. Formatting and type-keyword case
/// are not relationships; columns, keys, nullability, defaults, table flags,
/// foreign keys, index expressions/collations and the object inventory are.
/// Unsupported constraint forms are refused instead of normalizing SQL.
fn qualify_schema_relationships(
    actual: &Connection,
    include_message_seq: bool,
    include_provider_config: bool,
) -> Result<(), TransferError> {
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(PINNED_SCHEMA_SQL)?;
    if include_message_seq {
        expected.execute_batch(
            "CREATE TABLE message_seq (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL);",
        )?;
    }
    if include_provider_config {
        expected
            .execute_batch("CREATE TABLE provider_config (id TEXT PRIMARY KEY, value TEXT);")?;
    }
    let objects =
        |connection: &Connection| -> Result<Vec<(String, String, String, String)>, TransferError> {
            let mut statement = connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name,tbl_name")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        };
    let actual_objects = objects(actual)?;
    let expected_objects = objects(&expected)?;
    let identities = |objects: &[(String, String, String, String)]| {
        objects
            .iter()
            .map(|(kind, name, table, _)| (kind.clone(), name.clone(), table.clone()))
            .collect::<Vec<_>>()
    };
    if identities(&actual_objects) != identities(&expected_objects) {
        return Err(TransferError::Blocked(
            "source schema object inventory differs from pinned OpenCode".into(),
        ));
    }
    for (kind, name, _, sql) in &actual_objects {
        let upper = sql.to_ascii_uppercase();
        if upper
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|word| {
                matches!(
                    word,
                    "CHECK"
                        | "COLLATE"
                        | "DEFERRABLE"
                        | "INITIALLY"
                        | "AUTOINCREMENT"
                        | "CONFLICT"
                        | "GENERATED"
                        | "STRICT"
                        | "WITHOUT"
                )
            })
        {
            return Err(TransferError::Blocked(
                "source schema has an unqualified constraint form".into(),
            ));
        }
        let quoted = name.replace('"', "\"\"");
        if kind == "table" {
            let metadata = |connection: &Connection| -> Result<Vec<SerializedRow>, TransferError> {
                let mut columns =
                    schema_pragma_rows(connection, &format!("PRAGMA table_xinfo(\"{quoted}\")"))?;
                for column in &mut columns {
                    if let Some(SerializedSqlValue::Text { value }) = column.values.get_mut("type")
                    {
                        *value = value.to_ascii_uppercase();
                    }
                }
                let mut relationships = columns;
                relationships.extend(schema_pragma_rows(
                    connection,
                    &format!("PRAGMA foreign_key_list(\"{quoted}\")"),
                )?);
                relationships.extend(schema_pragma_rows(connection, &format!("SELECT type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name='{quoted}'"))?);
                let mut indexes =
                    schema_pragma_rows(connection, &format!("PRAGMA index_list(\"{quoted}\")"))?;
                for index in &mut indexes {
                    index.values.remove("seq");
                }
                indexes.sort_by(|left, right| left.values.cmp(&right.values));
                for index in &indexes {
                    if let Some(SerializedSqlValue::Text { value }) = index.values.get("name") {
                        let value = value.replace('"', "\"\"");
                        relationships.extend(schema_pragma_rows(
                            connection,
                            &format!("PRAGMA index_xinfo(\"{value}\")"),
                        )?);
                    }
                }
                relationships.extend(indexes);
                Ok(relationships)
            };
            if metadata(actual)? != metadata(&expected)? {
                return Err(TransferError::Blocked(format!(
                    "source schema relationships differ for pinned table {name}"
                )));
            }
        } else if kind == "index" {
            // The pinned indexes contain only their exact named columns. A
            // new expression or partial predicate has no qualified contract.
            if schema_pragma_rows(actual, &format!("PRAGMA index_xinfo(\"{quoted}\")"))?
                != schema_pragma_rows(&expected, &format!("PRAGMA index_xinfo(\"{quoted}\")"))?
            {
                return Err(TransferError::Blocked(
                    "source index relationships differ".into(),
                ));
            }
        } else {
            return Err(TransferError::Blocked(
                "source has an unqualified view or trigger".into(),
            ));
        }
    }
    Ok(())
}

fn schema_pragma_rows(
    connection: &Connection,
    sql: &str,
) -> Result<Vec<SerializedRow>, TransferError> {
    let mut statement = connection.prepare(sql)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([], |row| {
            let values = columns
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => SerializedSqlValue::Null,
                        ValueRef::Integer(value) => SerializedSqlValue::Integer { value },
                        ValueRef::Real(value) => SerializedSqlValue::Real {
                            bits: format!("{:016x}", value.to_bits()),
                        },
                        ValueRef::Text(value) => SerializedSqlValue::Text {
                            value: String::from_utf8_lossy(value).into_owned(),
                        },
                        ValueRef::Blob(value) => SerializedSqlValue::Blob {
                            hex: hex::encode(value),
                        },
                    };
                    Ok((name.clone(), value))
                })
                .collect::<Result<BTreeMap<_, _>, rusqlite::Error>>()?;
            Ok(SerializedRow {
                table: "schema_relationship".into(),
                key: Vec::new(),
                values,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, TransferError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn schema_fingerprint(connection: &Connection) -> Result<String, TransferError> {
    let mut statement = connection.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
         ORDER BY type, name, tbl_name",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&rows)
        .map_err(|error| TransferError::Serialization(error.to_string()))?;
    Ok(digest(&bytes))
}

fn migration_fingerprint(connection: &Connection) -> Result<String, TransferError> {
    let mut statement =
        connection.prepare("SELECT id, time_completed FROM migration ORDER BY id")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let found: BTreeSet<_> = rows.iter().map(|(id, _)| id.as_str()).collect();
    let expected: BTreeSet<_> = PINNED_MIGRATIONS.iter().copied().collect();
    if found != expected {
        return Err(TransferError::Blocked(
            "source migration journal does not match OpenCode v1.18.21".into(),
        ));
    }
    let mut data_migration_statement =
        connection.prepare("SELECT name, time_completed FROM data_migration ORDER BY name")?;
    let data_migrations = data_migration_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let data_migration_names: BTreeSet<_> = data_migrations
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let expected_data_migrations: BTreeSet<_> = PINNED_DATA_MIGRATIONS.iter().copied().collect();
    if data_migration_names != expected_data_migrations {
        return Err(TransferError::Blocked(
            "source data-migration journal does not match OpenCode v1.18.21".into(),
        ));
    }
    let bytes = serde_json::to_vec(&(rows, data_migrations))
        .map_err(|error| TransferError::Serialization(error.to_string()))?;
    Ok(digest(&bytes))
}

fn collect_exact_closure(
    connection: &Connection,
    root_session_id: &str,
) -> Result<Vec<SerializedRow>, TransferError> {
    let root = read_rows(connection, "session", "id = ?1", &[root_session_id], "id")?;
    let root = root.first().ok_or_else(|| {
        TransferError::Blocked("the exact root session disappeared from the snapshot".into())
    })?;
    if value_text(root, "parent_id")?.is_some() {
        return Err(TransferError::Blocked(
            "selected root has a parent and is not a native conversation root".into(),
        ));
    }

    let sessions = read_recursive_sessions(connection, root_session_id)?;
    if sessions.is_empty() {
        return Err(TransferError::Blocked(
            "the exact root session disappeared from the snapshot".into(),
        ));
    }
    let session_ids: Vec<String> = sessions
        .iter()
        .map(|row| required_text(row, "id"))
        .collect::<Result<_, _>>()?;
    let unique_session_ids: BTreeSet<_> = session_ids.iter().collect();
    if unique_session_ids.len() != session_ids.len() {
        return Err(TransferError::Blocked(
            "recursive session graph contains duplicate native IDs".into(),
        ));
    }
    let session_set: BTreeSet<_> = session_ids.iter().map(String::as_str).collect();
    for session in &sessions {
        if let Some(parent_id) = value_text(session, "parent_id")? {
            if !session_set.contains(parent_id.as_str()) {
                return Err(TransferError::Blocked(
                    "session descendant has a dangling parent relationship".into(),
                ));
            }
        }
    }

    let project_ids = unique_text_values(&sessions, "project_id")?;
    let workspace_ids = unique_optional_text_values(&sessions, "workspace_id")?;
    let mut projects = Vec::new();
    for project_id in &project_ids {
        projects.extend(read_rows(
            connection,
            "project",
            "id = ?1",
            &[project_id.as_str()],
            "id",
        )?);
    }
    if projects.len() != project_ids.len() {
        return Err(TransferError::Blocked(
            "session graph references a missing project".into(),
        ));
    }

    let mut workspaces = Vec::new();
    for workspace_id in &workspace_ids {
        workspaces.extend(read_rows(
            connection,
            "workspace",
            "id = ?1",
            &[workspace_id.as_str()],
            "id",
        )?);
    }
    if workspaces.len() != workspace_ids.len() {
        return Err(TransferError::Blocked(
            "session graph references a missing workspace".into(),
        ));
    }
    let workspace_projects: BTreeMap<String, String> = workspaces
        .iter()
        .map(|row| Ok((required_text(row, "id")?, required_text(row, "project_id")?)))
        .collect::<Result<_, TransferError>>()?;
    for session in &sessions {
        if let Some(workspace_id) = value_text(session, "workspace_id")? {
            if workspace_projects.get(&workspace_id) != Some(&required_text(session, "project_id")?)
            {
                return Err(TransferError::Blocked(
                    "session workspace belongs to a different project".into(),
                ));
            }
        }
    }

    let mut project_directories = Vec::new();
    let mut project_directory_keys = BTreeSet::new();
    for session in &sessions {
        let project_id = required_text(session, "project_id")?;
        let directory = required_text(session, "directory")?;
        let key = (project_id.clone(), directory.clone());
        if project_directory_keys.insert(key) {
            project_directories.extend(read_rows(
                connection,
                "project_directory",
                "project_id = ?1 AND directory = ?2",
                &[project_id.as_str(), directory.as_str()],
                "project_id, directory",
            )?);
        }
    }

    let mut permissions = Vec::new();
    for project_id in &project_ids {
        permissions.extend(read_rows(
            connection,
            "permission",
            "project_id = ?1",
            &[project_id.as_str()],
            "project_id, action, resource, id",
        )?);
    }

    let mut messages = Vec::new();
    let mut parts = Vec::new();
    let mut events = Vec::new();
    let mut event_sequences = Vec::new();
    let mut session_messages = Vec::new();
    let mut session_inputs = Vec::new();
    let mut session_context_epochs = Vec::new();
    let mut todos = Vec::new();
    for session_id in &session_ids {
        messages.extend(read_rows(
            connection,
            "message",
            "session_id = ?1",
            &[session_id.as_str()],
            "time_created, id",
        )?);
        parts.extend(read_rows(
            connection,
            "part",
            "session_id = ?1",
            &[session_id.as_str()],
            "time_created, id",
        )?);
        event_sequences.extend(read_rows(
            connection,
            "event_sequence",
            "aggregate_id = ?1",
            &[session_id.as_str()],
            "aggregate_id",
        )?);
        events.extend(read_rows(
            connection,
            "event",
            "aggregate_id = ?1",
            &[session_id.as_str()],
            "aggregate_id, seq",
        )?);
        session_messages.extend(read_rows(
            connection,
            "session_message",
            "session_id = ?1",
            &[session_id.as_str()],
            "seq, id",
        )?);
        session_inputs.extend(read_rows(
            connection,
            "session_input",
            "session_id = ?1",
            &[session_id.as_str()],
            "admitted_seq, id",
        )?);
        session_context_epochs.extend(read_rows(
            connection,
            "session_context_epoch",
            "session_id = ?1",
            &[session_id.as_str()],
            "session_id",
        )?);
        todos.extend(read_rows(
            connection,
            "todo",
            "session_id = ?1",
            &[session_id.as_str()],
            "position",
        )?);
    }

    let message_sessions: BTreeMap<_, _> = messages
        .iter()
        .map(|row| Ok((required_text(row, "id")?, required_text(row, "session_id")?)))
        .collect::<Result<_, TransferError>>()?;
    let mut part_ids = BTreeSet::new();
    for part in &parts {
        let message_id = required_text(part, "message_id")?;
        let part_session = required_text(part, "session_id")?;
        if message_sessions.get(&message_id).map(String::as_str) != Some(part_session.as_str()) {
            return Err(TransferError::Blocked(
                "part references a missing message or crosses session ownership".into(),
            ));
        }
        part_ids.insert(required_text(part, "id")?);
    }
    for (message_id, message_session) in &message_sessions {
        for part in read_rows(
            connection,
            "part",
            "message_id = ?1",
            &[message_id.as_str()],
            "time_created, id",
        )? {
            let part_session = required_text(&part, "session_id")?;
            if &part_session != message_session {
                return Err(TransferError::Blocked(
                    "part references a message owned by a different session".into(),
                ));
            }
            if part_ids.insert(required_text(&part, "id")?) {
                parts.push(part);
            }
        }
    }
    if !events.is_empty() {
        let sequence_ids: BTreeSet<_> = event_sequences
            .iter()
            .filter_map(|row| value_text(row, "aggregate_id").ok().flatten())
            .collect();
        if events.iter().any(|row| {
            value_text(row, "aggregate_id")
                .ok()
                .flatten()
                .is_none_or(|id| !sequence_ids.contains(&id))
        }) {
            return Err(TransferError::Blocked(
                "event row has no selected event-sequence dependency".into(),
            ));
        }
    }

    let mut output = Vec::new();
    output.extend(projects);
    output.extend(workspaces);
    output.extend(project_directories);
    output.extend(permissions);
    output.extend(sessions);
    output.extend(messages);
    output.extend(parts);
    output.extend(event_sequences);
    output.extend(events);
    output.extend(session_messages);
    output.extend(session_inputs);
    output.extend(session_context_epochs);
    output.extend(todos);
    Ok(output)
}

fn read_recursive_sessions(
    connection: &Connection,
    root_session_id: &str,
) -> Result<Vec<SerializedRow>, TransferError> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE descendants(row_id, id) AS (
           SELECT rowid, id FROM session WHERE id = ?1 AND parent_id IS NULL
           UNION
           SELECT child.rowid, child.id FROM session child
           JOIN descendants parent ON child.parent_id = parent.id
         )
         SELECT session.* FROM session
         JOIN descendants ON session.rowid = descendants.row_id
         ORDER BY session.time_created, session.id",
    )?;
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let rows = statement
        .query_map([root_session_id], |row| {
            serialize_row(row, "session", &names)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for row in &rows {
        validate_primary_key(row)?;
    }
    Ok(rows)
}

fn read_rows(
    connection: &Connection,
    table: &str,
    predicate: &str,
    parameters: &[&str],
    order_by: &str,
) -> Result<Vec<SerializedRow>, TransferError> {
    // `table`, predicate, and ordering are internal constants selected by the
    // exporter; no client value is interpolated into SQL syntax.
    let sql = format!("SELECT * FROM {table} WHERE {predicate} ORDER BY {order_by}");
    let mut statement = connection.prepare(&sql)?;
    let names = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let rows = statement
        .query_map(params_from_iter(parameters.iter().copied()), |row| {
            serialize_row(row, table, &names)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for row in &rows {
        validate_primary_key(row)?;
    }
    Ok(rows)
}

fn serialize_row(
    row: &Row<'_>,
    table: &str,
    column_names: &[String],
) -> rusqlite::Result<SerializedRow> {
    let mut values = BTreeMap::new();
    for (index, name) in column_names.iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => SerializedSqlValue::Null,
            ValueRef::Integer(value) => SerializedSqlValue::Integer { value },
            ValueRef::Real(value) => SerializedSqlValue::Real {
                bits: format!("{:016x}", value.to_bits()),
            },
            ValueRef::Text(value) => SerializedSqlValue::Text {
                value: std::str::from_utf8(value)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?
                    .to_string(),
            },
            ValueRef::Blob(value) => SerializedSqlValue::Blob {
                hex: hex::encode(value),
            },
        };
        values.insert(name.clone(), value);
    }
    let primary_key_columns = primary_key_columns(table);
    let key = primary_key_columns
        .iter()
        .filter_map(|column| values.get(*column).cloned())
        .collect();
    Ok(SerializedRow {
        table: table.to_string(),
        key,
        values,
    })
}

fn primary_key_columns(table: &str) -> &'static [&'static str] {
    match table {
        "project_directory" => &["project_id", "directory"],
        "todo" => &["session_id", "position"],
        "event_sequence" => &["aggregate_id"],
        "session_context_epoch" => &["session_id"],
        _ => &["id"],
    }
}

fn validate_primary_key(row: &SerializedRow) -> Result<(), TransferError> {
    let expected_key_length = primary_key_columns(&row.table).len();
    if row.key.len() != expected_key_length
        || row
            .key
            .iter()
            .any(|value| matches!(value, SerializedSqlValue::Null))
    {
        return Err(TransferError::Blocked(format!(
            "native {} row is missing its complete primary key",
            row.table
        )));
    }
    Ok(())
}

fn value_text(row: &SerializedRow, key: &str) -> Result<Option<String>, TransferError> {
    match row.values.get(key) {
        Some(SerializedSqlValue::Null) | None => Ok(None),
        Some(SerializedSqlValue::Text { value }) => Ok(Some(value.clone())),
        _ => Err(TransferError::Blocked(format!(
            "native row has a non-text {key} relationship"
        ))),
    }
}

fn required_text(row: &SerializedRow, key: &str) -> Result<String, TransferError> {
    value_text(row, key)?.ok_or_else(|| {
        TransferError::Blocked(format!("native row is missing its required {key} value"))
    })
}

fn unique_text_values(rows: &[SerializedRow], key: &str) -> Result<Vec<String>, TransferError> {
    let mut values = BTreeSet::new();
    for row in rows {
        values.insert(required_text(row, key)?);
    }
    Ok(values.into_iter().collect())
}

fn unique_optional_text_values(
    rows: &[SerializedRow],
    key: &str,
) -> Result<Vec<String>, TransferError> {
    let mut values = BTreeSet::new();
    for row in rows {
        if let Some(value) = value_text(row, key)? {
            values.insert(value);
        }
    }
    Ok(values.into_iter().collect())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn digest_serializable(value: &impl Serialize) -> Result<String, TransferError> {
    let mut hasher = Sha256::new();
    {
        let mut writer = HashingWriter::new(io::sink(), &mut hasher, MAX_BUNDLE_BYTES);
        let result = serde_json::to_writer(&mut writer, value);
        if writer.limit_exceeded {
            return Err(TransferError::Blocked(
                "one native row exceeds the 8 GiB bundle bound".into(),
            ));
        }
        result.map_err(|error| TransferError::Serialization(error.to_string()))?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn digest_reader(reader: &mut impl Read) -> Result<String, TransferError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 256 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod windows_file_url_tests {
    use super::*;

    #[test]
    fn decodes_windows_drive_letter_file_urls() {
        assert_eq!(
            decode_windows_file_url_path("file:///C:/Users/Dan/tool%20output/tool_1").unwrap(),
            r"C:\Users\Dan\tool output\tool_1"
        );
        assert_eq!(
            decode_windows_file_url_path("file://localhost/d:/OpenCode/tool-output/tool_2")
                .unwrap(),
            r"d:\OpenCode\tool-output\tool_2"
        );
    }

    #[test]
    fn rejects_unc_file_urls_as_unsupported() {
        assert!(matches!(
            decode_windows_file_url_path("file://server/share/tool-output/tool_1"),
            Err(TransferError::Blocked(_))
        ));
    }
}

#[cfg(test)]
mod windows_extraction_acl_tests {
    use super::*;

    #[test]
    fn shared_windows_acl_evidence_is_not_private() {
        let shared = WindowsAclEvidence {
            owner_is_current_user: true,
            dacl_present: true,
            dacl_protected: false,
            ace_count: 2,
            current_user_has_full_access: true,
            all_children_inherit_current_user_access: false,
        };

        assert!(!windows_acl_is_private(&shared));
    }

    #[test]
    fn accepts_a_protected_current_user_only_windows_acl() {
        let private = WindowsAclEvidence {
            owner_is_current_user: true,
            dacl_present: true,
            dacl_protected: true,
            ace_count: 1,
            current_user_has_full_access: true,
            all_children_inherit_current_user_access: true,
        };

        assert!(windows_acl_is_private(&private));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_shared_existing_directory_without_changing_its_acl() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("shared-extraction-root");
        windows_acl::create_test_directory_with_world_access(&path).unwrap();
        let before = windows_acl::read_acl_evidence(&path).unwrap();
        assert!(!windows_acl_is_private(&before));

        let result = prepare_extraction_root(&path);

        assert!(matches!(result, Err(TransferError::Blocked(_))));
        assert_eq!(windows_acl::read_acl_evidence(&path).unwrap(), before);
    }

    #[cfg(windows)]
    #[test]
    fn creates_a_private_windows_extraction_root_and_reuses_it() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private-extraction-root");

        assert_eq!(prepare_extraction_root(&path).unwrap(), path);
        assert!(windows_acl_is_private(
            &windows_acl::read_acl_evidence(&path).unwrap()
        ));
        assert_eq!(prepare_extraction_root(&path).unwrap(), path);
    }
}

#[cfg(test)]
mod online_backup_tests {
    use super::*;

    fn source_fixture(path: &Path, journal: &str) -> Connection {
        let writer = Connection::open(path).unwrap();
        writer
            .execute_batch(&format!(
                "PRAGMA page_size=4096; PRAGMA journal_mode={journal};
             PRAGMA wal_autocheckpoint=0;
             CREATE TABLE payload(id INTEGER PRIMARY KEY, revision INTEGER, body BLOB);
             WITH RECURSIVE rows(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM rows WHERE id<3072)
             INSERT INTO payload SELECT id,0,zeroblob(4050) FROM rows;"
            ))
            .unwrap();
        writer
    }

    fn revision(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT revision FROM payload WHERE id=1", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn online_backup_completes_initial_wal_snapshot_while_each_step_has_a_writer_commit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.db");
        let writer = source_fixture(&path, "WAL");
        let reader = open_source_read_only(&path).unwrap();
        let destination = directory.path().join("snapshot.db");
        let mut steps = 0;
        let mut remaining = Vec::new();
        let result = create_online_backup_with_progress(&reader, &destination, |progress| {
            steps += 1;
            remaining.push(progress.remaining);
            writer.execute("UPDATE payload SET revision=revision+1 WHERE id=1", [])?;
            if steps == 64 {
                return Err(TransferError::Blocked(
                    "fixture backup failed to finish in 64 steps".into(),
                ));
            }
            Ok(())
        });
        assert!(result.is_ok(), "backup must make bounded progress with ongoing WAL commits: {result:?}; remaining={remaining:?}");
        assert!(
            steps > 1,
            "fixture must exercise writes between backup steps"
        );
        assert!(
            remaining.windows(2).all(|pair| pair[1] < pair[0]),
            "pinned backup must advance: {remaining:?}"
        );
        assert!(
            reader.is_autocommit(),
            "capture must release its read transaction"
        );
        let pages: i64 = writer
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        eprintln!(
            "online_backup_fixture sqlite={} pages={pages} steps={steps} writer_commits={steps} remaining={remaining:?}",
            rusqlite::version()
        );
        let snapshot = open_source_read_only(&destination).unwrap();
        assert_eq!(revision(&snapshot), 0);
        assert_eq!(
            snapshot
                .query_row(
                    "SELECT count(*) FROM payload WHERE length(body)=4050",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3072
        );
        assert_eq!(revision(&writer), steps);
        assert_eq!(
            snapshot
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            snapshot
                .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
    }

    #[test]
    fn online_backup_releases_rollback_journal_reader_after_success_and_interruption() {
        for interrupt in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("source.db");
            let writer = source_fixture(&path, "DELETE");
            writer.busy_timeout(Duration::ZERO).unwrap();
            let reader = open_source_read_only(&path).unwrap();
            let destination = directory.path().join("snapshot.db");
            let mut steps = 0;
            let result = create_online_backup_with_progress(&reader, &destination, |_| {
                steps += 1;
                let error = writer
                    .execute("UPDATE payload SET revision=revision+1 WHERE id=1", [])
                    .unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                if interrupt {
                    Err(TransferError::Blocked("owned fixture interruption".into()))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.is_err(), interrupt);
            assert!(steps > 0);
            assert!(
                reader.is_autocommit(),
                "success and error must release the pinned reader"
            );
            writer
                .execute("UPDATE payload SET revision=revision+1 WHERE id=1", [])
                .unwrap();
            if interrupt {
                let aborted = open_source_read_only(&destination).unwrap();
                assert_eq!(
                    aborted
                        .query_row(
                            "SELECT count(*) FROM sqlite_schema WHERE name='payload'",
                            [],
                            |row| row.get::<_, i64>(0)
                        )
                        .unwrap(),
                    0,
                    "partial backup must roll back"
                );
                let retry = directory.path().join("retry.db");
                create_online_backup(&reader, &retry).unwrap();
                assert_eq!(revision(&open_source_read_only(&retry).unwrap()), 1);
            } else {
                assert_eq!(revision(&open_source_read_only(&destination).unwrap()), 0);
            }
        }
    }

    #[test]
    fn online_backup_refuses_persistent_destination_lock_and_releases_reader() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.db");
        let writer = source_fixture(&path, "WAL");
        let reader = open_source_read_only(&path).unwrap();
        let destination = directory.path().join("snapshot.db");
        let locked = Connection::open(&destination).unwrap();
        locked
            .execute_batch("BEGIN EXCLUSIVE; CREATE TABLE blocker(id INTEGER)")
            .unwrap();
        // Even a regression that retries forever must fail this owned fixture
        // finitely, after two unsuccessful steps through the real backup API.
        let mut attempts = 0;
        let result = create_online_backup_with_progress(&reader, &destination, |_| {
            attempts += 1;
            if attempts == 2 {
                Err(TransferError::Blocked(
                    "fixture lock retry bound exhausted".into(),
                ))
            } else {
                Ok(())
            }
        });
        assert!(
            matches!(result, Err(TransferError::Blocked(ref reason)) if reason.contains("remained locked without progress")),
            "persistent lock must refuse rather than retry indefinitely: {result:?}"
        );
        assert!(reader.is_autocommit());
        locked.execute_batch("ROLLBACK").unwrap();
        writer
            .execute("UPDATE payload SET revision=revision+1 WHERE id=1", [])
            .unwrap();
        create_online_backup(&reader, &destination).unwrap();
        assert_eq!(revision(&open_source_read_only(&destination).unwrap()), 1);
    }
}

#[cfg(test)]
mod native_source_inventory_tests {
    use super::*;

    #[derive(Default)]
    struct PayloadWriter {
        bytes: Vec<u8>,
        writes: usize,
        flushes: usize,
        max_write: Option<usize>,
        fail_write: bool,
        fail_flush: bool,
    }

    impl Write for PayloadWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            if self.fail_write {
                return Err(io::Error::other("injected payload write failure"));
            }
            let written = bytes.len().min(self.max_write.unwrap_or(usize::MAX));
            self.bytes.extend_from_slice(&bytes[..written]);
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            if self.fail_flush {
                return Err(io::Error::other("injected payload flush failure"));
            }
            Ok(())
        }
    }

    #[test]
    fn payload_serialization_coalesces_writes_without_changing_complete_export() {
        let fixture = reuse_fixture(false);
        let file = fixture.dir.path().join("workspace/reference.txt");
        fs::write(&file, b"retained workspace asset").unwrap();
        let db = Connection::open(&fixture.inventory.default_database).unwrap();
        for index in 0..160 {
            let part =
                serde_json::json!({"type":"text","text":"escaped \" text\\\n\tλ".repeat(48)});
            db.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?1,'msg','ses_exact',1,1,?2)", rusqlite::params![format!("text{index}"), part.to_string()]).unwrap();
        }
        db.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('file','msg','ses_exact',1,1,?1)", [serde_json::json!({"type":"file","mime":"text/plain","url":format!("file://{}", file.display())}).to_string()]).unwrap();
        drop(db);
        let (exported, _, _) = reuse_export(&fixture, None);
        let expected = fs::read(&exported.payload_path).unwrap();
        let document: serde_json::Value = serde_json::from_slice(&expected).unwrap();
        let rows: Vec<SerializedRow> = serde_json::from_value(document["rows"].clone()).unwrap();
        let assets: Vec<SerializedAssetMetadata> =
            serde_json::from_value(document["assets"].clone()).unwrap();
        let objects: Vec<SerializedSnapshotObject> =
            serde_json::from_value(document["snapshot_objects"].clone()).unwrap();
        assert!(rows.len() > 160);
        assert_eq!(assets.len(), 1);
        assert_eq!(objects.len(), 4);
        assert_eq!(exported.manifest.saved_snapshots.len(), 2);
        let payload = TransferPayload {
            version: EXPORT_VERSION,
            root_session_id: "ses_exact",
            rows: &rows,
            assets: &assets,
            saved_snapshots: &exported.manifest.saved_snapshots,
            snapshot_objects: &objects,
        };
        let mut unbuffered = PayloadWriter::default();
        serde_json::to_writer(&mut unbuffered, &payload).unwrap();
        assert_eq!(unbuffered.bytes, expected);
        let mut write_error = PayloadWriter {
            fail_write: true,
            ..Default::default()
        };
        assert!(matches!(
            serialize_transfer_payload(&mut write_error, &payload, MAX_BUNDLE_BYTES),
            Err(TransferError::Serialization(_))
        ));
        assert!(write_error.bytes.is_empty());
        assert_eq!(write_error.flushes, 0);
        for max_write in [None, Some(997)] {
            let mut underlying = PayloadWriter {
                max_write,
                ..Default::default()
            };
            let counted_export = export_exact_session_inner(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
                |_| Ok(&mut underlying),
            )
            .unwrap();
            let bytes = counted_export.manifest.payload_bytes;
            let sha256 = &counted_export.manifest.payload_sha256;
            assert_eq!(underlying.bytes, expected);
            assert_eq!(bytes, expected.len() as u64);
            assert_eq!(*sha256, digest(&expected));
            assert_eq!(bytes, exported.manifest.payload_bytes);
            assert_eq!(*sha256, exported.manifest.payload_sha256);
            assert_eq!(underlying.flushes, 1);
            assert_eq!(
                serde_json::to_value(counted_export.manifest()).unwrap(),
                serde_json::to_value(exported.manifest()).unwrap()
            );
            assert_eq!(
                source_graph_fingerprint(counted_export.manifest()).unwrap(),
                source_graph_fingerprint(exported.manifest()).unwrap()
            );
            eprintln!(
                "payload bytes={bytes}, underlying writes={} -> {}, max_write={max_write:?}",
                unbuffered.writes, underlying.writes
            );
            assert!(
                underlying.writes < unbuffered.writes / 10,
                "production serialization must coalesce actual underlying fragment writes"
            );
        }
    }

    #[test]
    fn payload_serialization_refuses_bounds_and_propagates_final_flush_failures() {
        let payload = TransferPayload {
            version: EXPORT_VERSION,
            root_session_id: "ses_escaped_\"\\\n",
            rows: &[],
            assets: &[],
            saved_snapshots: &[],
            snapshot_objects: &[],
        };
        let expected = serde_json::to_vec(&payload).unwrap();
        let mut exact = PayloadWriter {
            max_write: Some(3),
            ..Default::default()
        };
        assert_eq!(
            serialize_transfer_payload(&mut exact, &payload, expected.len() as u64).unwrap(),
            (expected.len() as u64, digest(&expected))
        );
        assert_eq!(exact.bytes, expected);
        let mut zero_write = PayloadWriter {
            max_write: Some(0),
            ..Default::default()
        };
        assert!(matches!(
            serialize_transfer_payload(&mut zero_write, &payload, MAX_BUNDLE_BYTES),
            Err(TransferError::Io(_))
        ));
        assert!(zero_write.bytes.is_empty());
        assert!(zero_write.writes > 0);
        assert_eq!(zero_write.flushes, 0);
        for limit in [0, expected.len() as u64 - 1] {
            let mut underlying = PayloadWriter::default();
            assert!(matches!(
                serialize_transfer_payload(&mut underlying, &payload, limit),
                Err(TransferError::Blocked(reason)) if reason == "exact-session bundle exceeds 8 GiB"
            ));
            assert!(underlying.bytes.len() as u64 <= limit);
            assert_eq!(underlying.flushes, 0);
        }
        // The complete small document fits in the production buffer, so this
        // first underlying write fails only when the final flush drains it.
        let mut deferred_write_error = PayloadWriter {
            fail_write: true,
            ..Default::default()
        };
        assert!(matches!(
            serialize_transfer_payload(&mut deferred_write_error, &payload, MAX_BUNDLE_BYTES),
            Err(TransferError::Io(error)) if error == "injected payload write failure"
        ));
        assert!(deferred_write_error.bytes.is_empty());
        let mut flush_error = PayloadWriter {
            fail_flush: true,
            ..Default::default()
        };
        assert!(matches!(
            serialize_transfer_payload(&mut flush_error, &payload, MAX_BUNDLE_BYTES),
            Err(TransferError::Io(error)) if error == "injected payload flush failure"
        ));
        assert_eq!(flush_error.bytes, expected);
        assert_eq!(flush_error.flushes, 1);
    }

    #[test]
    fn payload_serialization_final_flush_failure_refuses_export_and_cleans_extraction() {
        let fixture = reuse_fixture(false);
        let extraction_root = fixture.dir.path().join("extract");
        let (complete, _, _) = reuse_export(&fixture, None);
        let expected = fs::read(&complete.payload_path).unwrap();
        assert!(expected.len() < PAYLOAD_WRITE_BUFFER_BYTES);
        drop(complete);
        for fail_write in [true, false] {
            let events = Arc::new(std::sync::Mutex::new(Vec::new()));
            let observed = events.clone();
            let mut underlying = PayloadWriter {
                fail_write,
                fail_flush: !fail_write,
                ..Default::default()
            };
            let result = export_exact_session_inner(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(extraction_root.clone()).with_progress_observer(move |event| {
                    observed.lock().unwrap().push(event);
                }),
                |_| Ok(&mut underlying),
            );
            assert!(matches!(result, Err(TransferError::Io(_))));
            assert_eq!(fs::read_dir(&extraction_root).unwrap().count(), 0);
            if fail_write {
                assert!(underlying.bytes.is_empty());
                assert!(underlying.writes > 0);
                assert_eq!(underlying.flushes, 0);
            } else {
                assert_eq!(underlying.bytes, expected);
                assert_eq!(underlying.flushes, 1);
            }
            let captured = events.lock().unwrap();
            let serialize = captured
                .iter()
                .filter(|event| event.phase == "serialize")
                .collect::<Vec<_>>();
            assert_eq!(serialize.first().unwrap().state, "started");
            assert_eq!(serialize.last().unwrap().state, "failed");
            assert!(!serialize.iter().any(|event| event.state == "completed"));
            assert!(!captured.iter().any(|event| event.phase == "row_digests"));
        }
    }

    struct ReuseFixture {
        dir: TempDir,
        inventory: HostOpenCodeInventory,
        store: PathBuf,
        trees: Vec<String>,
        blob: String,
    }

    fn fixture_git(git_dir: &Path, args: &[&str], input: Option<&[u8]>) -> String {
        let mut command = sanitized_git_command();
        command.arg("--git-dir").arg(git_dir).args(args);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        if let Some(input) = input {
            child.stdin.take().unwrap().write_all(input).unwrap();
        }
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{:?}", output);
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn reuse_fixture(packed: bool) -> ReuseFixture {
        reuse_fixture_with_blob(packed, b"synthetic overlapping saved blob")
    }

    fn reuse_fixture_with_blob(packed: bool, body: &[u8]) -> ReuseFixture {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let data_home = dir.path().join("data");
        fs::create_dir(&data_home).unwrap();
        let worktree = hex::encode(sha1::Sha1::digest(workspace.to_string_lossy().as_bytes()));
        let git_dir = data_home.join("snapshot/prj").join(worktree);
        fs::create_dir_all(&git_dir).unwrap();
        let git = |args: &[&str], input: Option<&[u8]>| fixture_git(&git_dir, args, input);
        git(&["init", "--bare", "-q"], None);
        let blob = git(&["hash-object", "-w", "--stdin"], Some(body));
        let subtree = git(
            &["mktree"],
            Some(format!("100644 blob {blob}\tnested\n").as_bytes()),
        );
        let mut trees = Vec::new();
        for name in ["first", "second"] {
            trees.push(git(
                &["mktree"],
                Some(
                    format!("100644 blob {blob}\t{name}\n040000 tree {subtree}\tsubtree\n")
                        .as_bytes(),
                ),
            ));
        }
        if packed {
            for (index, tree) in trees.iter().enumerate() {
                git(
                    &["update-ref", &format!("refs/fixture/{index}"), tree],
                    None,
                );
            }
            git(&["repack", "-a", "-d"], None);
            git(&["prune-packed"], None);
            assert!(!git_dir
                .join("objects")
                .join(&blob[..2])
                .join(&blob[2..])
                .exists());
        }
        let path = data_home.join("opencode.db");
        let db = source(&path);
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated,revert) VALUES ('ses_exact','slug','prj','/synthetic','synthetic','1',1,1,?1)", [serde_json::json!({"snapshot":trees[0]}).to_string()]).unwrap();
        db.execute("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg','ses_exact',1,1,'{}')", []).unwrap();
        for index in 0..6 {
            db.execute("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?1,'msg','ses_exact',1,1,?2)", rusqlite::params![format!("part{index}"), serde_json::json!({"type":"snapshot","snapshot":trees[index%2]}).to_string()]).unwrap();
        }
        let prompt = serde_json::json!({"parts":[{"type":"snapshot","snapshot":trees[0]}]});
        db.execute("INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,time_created) VALUES ('input','ses_exact',?1,'pending',1,1)", [prompt.to_string()]).unwrap();
        db.execute("INSERT INTO session_context_epoch(session_id,baseline,snapshot,baseline_seq) VALUES ('ses_exact','{}',?1,0)", [serde_json::json!({"messages":[prompt]}).to_string()]).unwrap();
        db.execute(
            "INSERT INTO event_sequence(aggregate_id,seq) VALUES ('ses_exact',1)",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES ('event','ses_exact',1,'message.part.updated',?1)", [serde_json::json!({"part":{"type":"snapshot","snapshot":trees[1]}}).to_string()]).unwrap();
        drop(db);
        let inventory = HostOpenCodeInventory::new(path).with_trusted_workspace_mount(
            "prj",
            None,
            "/synthetic",
            workspace,
        );
        ReuseFixture {
            dir,
            inventory,
            store: git_dir.join("objects"),
            trees,
            blob,
        }
    }

    fn reuse_export(
        fixture: &ReuseFixture,
        budget: Option<usize>,
    ) -> (OpenCodeNativeSnapshot, BTreeMap<&'static str, usize>, u64) {
        // Budget zero is the existing independently executed ordinary producer
        // control. Explicit policies below also exercise output reuse at zero.
        reuse_export_policy(fixture, budget, budget != Some(0))
    }

    fn reuse_export_policy(
        fixture: &ReuseFixture,
        budget: Option<usize>,
        reuse_output: bool,
    ) -> (OpenCodeNativeSnapshot, BTreeMap<&'static str, usize>, u64) {
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                budget,
                packed_output_disabled: !reuse_output,
                ..Default::default()
            };
        });
        let progress = std::sync::Arc::new(std::sync::Mutex::new(0));
        let observed = progress.clone();
        let reader_costs = Arc::new(std::sync::Mutex::new(None));
        let observed_costs = reader_costs.clone();
        let exported = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")).with_progress_observer(
                move |event| {
                    if event.phase == "saved_objects" && event.state == "completed" {
                        *observed.lock().unwrap() = event.completed_count;
                        *observed_costs.lock().unwrap() = event.reader_costs.clone();
                    }
                },
            ),
        )
        .unwrap();
        let mut counts = snapshot_reuse_test_hooks::STATE
            .with(|state| std::mem::take(&mut state.borrow_mut().counts));
        counts.insert(
            "fresh_inspections",
            reader_costs
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .fresh_inspections as usize,
        );
        let reads = *progress.lock().unwrap();
        (exported, counts, reads)
    }

    #[test]
    fn packed_output_reuse_survives_memo_pressure_with_every_current_native_proof() {
        let fixture = reuse_fixture(true);
        for budget in [0, 1, 1400, 3000] {
            let (old, old_counts, old_reads) = reuse_export_policy(&fixture, Some(budget), false);
            let (new, new_counts, new_reads) = reuse_export_policy(&fixture, Some(budget), true);
            assert_eq!(
                fs::read(&old.payload_path).unwrap(),
                fs::read(&new.payload_path).unwrap()
            );
            assert_eq!(
                serde_json::to_vec(old.manifest()).unwrap(),
                serde_json::to_vec(new.manifest()).unwrap()
            );
            assert_eq!(
                source_graph_fingerprint(old.manifest()).unwrap(),
                source_graph_fingerprint(new.manifest()).unwrap()
            );
            assert_eq!((old_reads, new_reads), (30, 30));
            for counts in [&old_counts, &new_counts] {
                assert_eq!(counts["fresh_inspections"], 30);
                assert_eq!(counts["packed_query"], 30);
                assert_eq!(counts["packed_validate"], 30);
                assert_eq!(counts["packed_spawn"], 1);
                assert_eq!(counts["packed_reap"], 1);
                assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
            }
            eprintln!("packed output budget={budget}: old={old_counts:?} new={new_counts:?}");
            assert_eq!(new_counts["deflate"], 4, "completed output eliminates repeat compression even when memo cannot retain the working set");
            assert_eq!(new_counts["hex"], 4);
            if budget <= 1 {
                assert_eq!(old_counts["deflate"], 30);
                assert_eq!(old_counts["hex"], 30);
            } else {
                assert!(old_counts["deflate"] > new_counts["deflate"]);
                assert!(
                    old_counts["memo_admit"] > 0,
                    "objects individually fit the memo but their working set does not"
                );
            }
            assert_exported_snapshot_native_readback(&fixture, &old, &format!("old-{budget}"));
            assert_exported_snapshot_native_readback(&fixture, &new, &format!("new-{budget}"));
        }
    }

    fn assert_exported_snapshot_native_readback(
        fixture: &ReuseFixture,
        snapshot: &OpenCodeNativeSnapshot,
        name: &str,
    ) {
        let payload: serde_json::Value =
            serde_json::from_slice(&fs::read(&snapshot.payload_path).unwrap()).unwrap();
        let objects: Vec<SerializedSnapshotObject> =
            serde_json::from_value(payload["snapshot_objects"].clone()).unwrap();
        let destination = fixture.dir.path().join(name).join("opencode.db");
        for object in &objects {
            install_snapshot_object(object, &snapshot.manifest().saved_snapshots, &destination)
                .unwrap();
            let bucket = destination
                .parent()
                .unwrap()
                .join("snapshot")
                .join(&object.project_id)
                .join(&object.worktree_sha1);
            let path = bucket
                .join("objects")
                .join(&object.object_id[..2])
                .join(&object.object_id[2..]);
            let compressed = fs::read(path).unwrap();
            assert_eq!(compressed, hex::decode(&object.compressed_hex).unwrap());
            let (kind, body) = decode_snapshot_object(&object.object_id, &compressed).unwrap();
            let output = Command::new("git")
                .arg("--git-dir")
                .arg(&bucket)
                .args(["cat-file", &kind, &object.object_id])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, body, "full native installed object body");
        }
        let payload_objects = objects
            .iter()
            .map(|object| (&object.project_id, &object.worktree_sha1, &object.object_id))
            .collect::<BTreeSet<_>>();
        let retained_objects = snapshot
            .manifest()
            .saved_snapshots
            .iter()
            .flat_map(|reference| {
                reference.objects.iter().map(|object| {
                    (
                        &reference.project_id,
                        &reference.worktree_sha1,
                        &object.object_id,
                    )
                })
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            payload_objects.len(),
            objects.len(),
            "no duplicate object tuples"
        );
        assert_eq!(
            payload_objects, retained_objects,
            "the real importer requires exactly the final retained object union"
        );
        for reference in &snapshot.manifest().saved_snapshots {
            if reference.availability == SavedSnapshotAvailability::UnavailableInQualifiedLocations
            {
                assert!(reference.objects.is_empty());
                continue;
            }
            let bucket = destination
                .parent()
                .unwrap()
                .join("snapshot")
                .join(&reference.project_id)
                .join(&reference.worktree_sha1);
            let stores = qualified_snapshot_stores(&bucket, &bucket.join("objects")).unwrap();
            let closure = read_snapshot_closure(&stores, &reference.tree)
                .unwrap()
                .unwrap();
            assert_eq!(closure.len(), reference.objects.len());
            for object in &reference.objects {
                let bytes = &closure[&object.object_id];
                assert_eq!(bytes.len() as u64, object.compressed_bytes);
                assert_eq!(digest(bytes), object.compressed_sha256);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn packed_output_reuse_refuses_actual_late_owner_failure_before_export_publication() {
        for (status, trailing) in [(9, false), (0, true)] {
            let fixture = reuse_fixture(true);
            let pids = fixture.dir.path().join("owned-native-pids");
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    budget: Some(0),
                    packed_late_fault: Some((status, trailing, pids.clone())),
                    ..Default::default()
                };
            });
            let result = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            );
            assert!(
                result.is_err(),
                "real late status/output cannot publish a complete warm-hit export"
            );
            assert_eq!(
                fs::read_dir(fixture.dir.path().join("extract"))
                    .unwrap()
                    .count(),
                0
            );
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(
                counts["deflate"], 4,
                "late failure occurs after all warm output hits"
            );
            assert_eq!(counts["hex"], 4);
            assert_eq!(counts["packed_query"], 30);
            assert_eq!(counts["packed_validate"], 30);
            assert_eq!(counts["packed_reap"], counts["packed_spawn"]);
            assert_eq!(counts["packed_drain_join"], counts["packed_drain_spawn"]);
            for pid in fs::read_to_string(pids).unwrap().split_whitespace() {
                assert!(
                    !Path::new(&format!("/proc/{pid}")).exists(),
                    "exact owned native/wrapper child settled"
                );
            }
        }
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[test]
    fn packed_output_reuse_preserves_current_nondefault_loose_encoding_transitions() {
        let fixture = reuse_fixture(true);
        let packed = read_snapshot_object(std::slice::from_ref(&fixture.store), &fixture.blob)
            .unwrap()
            .unwrap();
        let (_, body) = decode_snapshot_object(&fixture.blob, &packed).unwrap();
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
        write!(encoder, "blob {}\0", body.len()).unwrap();
        encoder.write_all(&body).unwrap();
        let loose = encoder.finish().unwrap();
        assert_ne!(loose, packed);
        let mut exports = Vec::new();
        for reuse in [false, true] {
            let path = fixture_object_path(&fixture, &fixture.blob);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let current_loose = loose.clone();
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    budget: Some(0),
                    packed_output_disabled: !reuse,
                    before_reference: Some(Box::new(move |number| {
                        if number == 2 || number == 4 {
                            fs::write(&path, &current_loose).unwrap();
                        }
                        if number == 3 || number == 5 {
                            fs::remove_file(&path).unwrap();
                        }
                    })),
                    ..Default::default()
                };
            });
            let exported = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            )
            .unwrap();
            assert_exported_snapshot_native_readback(
                &fixture,
                &exported,
                if reuse {
                    "transitions-new"
                } else {
                    "transitions-old"
                },
            );
            exports.push(exported);
        }
        assert_eq!(
            fs::read(&exports[0].payload_path).unwrap(),
            fs::read(&exports[1].payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_vec(exports[0].manifest()).unwrap(),
            serde_json::to_vec(exports[1].manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(exports[0].manifest()).unwrap(),
            source_graph_fingerprint(exports[1].manifest()).unwrap()
        );
        for reference in &exports[1].manifest().saved_snapshots {
            let blob = reference
                .objects
                .iter()
                .find(|object| object.object_id == fixture.blob)
                .unwrap();
            assert_eq!(blob.compressed_sha256, digest(&packed));
            assert_ne!(blob.compressed_sha256, digest(&loose));
        }
    }

    #[test]
    fn packed_output_reuse_hashes_full_multichunk_encoding_and_installs_native_bodies() {
        let body = (0u64..2048)
            .map(|index| digest(&index.to_le_bytes()))
            .collect::<String>();
        let fixture = reuse_fixture_with_blob(true, body.as_bytes());
        let (old, old_counts, _) = reuse_export_policy(&fixture, Some(0), false);
        let (new, new_counts, _) = reuse_export_policy(&fixture, Some(0), true);
        assert_eq!((old_counts["deflate"], new_counts["deflate"]), (30, 4));
        assert_eq!((old_counts["hex"], new_counts["hex"]), (30, 4));
        assert_eq!(
            fs::read(&old.payload_path).unwrap(),
            fs::read(&new.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_vec(old.manifest()).unwrap(),
            serde_json::to_vec(new.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(old.manifest()).unwrap(),
            source_graph_fingerprint(new.manifest()).unwrap()
        );
        assert!(new.manifest().saved_snapshots[0]
            .objects
            .iter()
            .any(|object| object.compressed_bytes > 8192));
        assert_exported_snapshot_native_readback(&fixture, &old, "multichunk-old");
        assert_exported_snapshot_native_readback(&fixture, &new, "multichunk-new");
        let actual = read_snapshot_object(std::slice::from_ref(&fixture.store), &fixture.blob)
            .unwrap()
            .unwrap();
        assert_eq!(
            snapshot_output_commitment(&hex::encode(&actual)).unwrap(),
            (actual.len() as u64, digest(&actual))
        );
        for invalid in [
            "0",
            "xx",
            &("00".repeat(8192) + "0"),
            &("00".repeat(8192) + "zz"),
        ] {
            assert!(snapshot_output_commitment(invalid).is_err());
        }
    }

    #[test]
    fn packed_output_reuse_keeps_native_destination_tuples_distinct() {
        let mut fixture = reuse_fixture(true);
        let workspace = fixture.dir.path().join("other-workspace");
        fs::create_dir(&workspace).unwrap();
        let worktree = hex::encode(sha1::Sha1::digest(workspace.to_string_lossy().as_bytes()));
        let bucket = fixture
            .inventory
            .default_database
            .parent()
            .unwrap()
            .join("snapshot/prj")
            .join(worktree);
        fixture_git(&bucket, &["init", "--bare", "-q"], None);
        copy_fixture_objects(&fixture.store, &bucket.join("objects"));
        fixture.inventory = fixture.inventory.with_trusted_workspace_mount(
            "prj",
            None,
            "/synthetic/other",
            workspace,
        );
        let db = Connection::open(&fixture.inventory.default_database).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,parent_id,directory,title,version,time_created,time_updated,revert) VALUES ('ses_other','other','prj','ses_exact','/synthetic/other','other','1',1,1,?1)", [serde_json::json!({"snapshot":fixture.trees[0]}).to_string()]).unwrap();
        drop(db);
        let (old, old_counts, old_reads) = reuse_export_policy(&fixture, Some(0), false);
        let (new, new_counts, new_reads) = reuse_export_policy(&fixture, Some(0), true);
        assert_eq!((old_reads, new_reads), (33, 33));
        assert_eq!(old_counts["deflate"], 33);
        assert_eq!(
            new_counts["deflate"], 7,
            "a different native bucket must produce its own first encoding"
        );
        assert_eq!(new_counts["packed_query"], 33);
        assert_eq!(new_counts["packed_validate"], 33);
        assert_eq!(
            fs::read(&old.payload_path).unwrap(),
            fs::read(&new.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_vec(old.manifest()).unwrap(),
            serde_json::to_vec(new.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(old.manifest()).unwrap(),
            source_graph_fingerprint(new.manifest()).unwrap()
        );
        assert_exported_snapshot_native_readback(&fixture, &old, "tuples-old");
        assert_exported_snapshot_native_readback(&fixture, &new, "tuples-new");
    }

    fn assert_reused_export(packed: bool) {
        let fixture = reuse_fixture(packed);
        let (plain, plain_counts, plain_reads) = reuse_export(&fixture, Some(0));
        let (reused, counts, reads) = reuse_export(&fixture, None);
        assert_eq!(
            fs::read(&plain.payload_path).unwrap(),
            fs::read(&reused.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(plain.manifest()).unwrap(),
            serde_json::to_value(reused.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(plain.manifest()).unwrap(),
            source_graph_fingerprint(reused.manifest()).unwrap()
        );
        assert_eq!(reads, plain_reads);
        assert_eq!(
            reads, 30,
            "all ten references traverse their complete three-object closure"
        );
        let payload: serde_json::Value =
            serde_json::from_slice(&fs::read(&reused.payload_path).unwrap()).unwrap();
        assert_eq!(payload["snapshot_objects"].as_array().unwrap().len(), 4);
        assert_eq!(reused.manifest().saved_snapshots.len(), 2);
        assert_eq!(
            counts["hex"], 4,
            "unchanged representations must be encoded once per export"
        );
        assert_eq!(counts["tree_parse"], 3);
        assert_eq!(plain_counts["hex"], 30);
        if packed {
            assert_eq!(
                counts["packed_validate"], 30,
                "every fresh packed body must prove its current SHA1"
            );
            assert_eq!(counts["deflate"], 4);
            assert_eq!(plain_counts["deflate"], 30);
            assert_eq!(counts["packed_query"], 30);
            assert_eq!(plain_counts["packed_query"], 30);
            assert_eq!(
                counts["packed_spawn"], 1,
                "one export must reuse its current qualified packed decoder"
            );
            assert_eq!(plain_counts["packed_spawn"], 1);
            assert_eq!(counts["packed_reap"], counts["packed_spawn"]);
            assert_eq!(plain_counts["packed_reap"], plain_counts["packed_spawn"]);
            assert_eq!(counts["packed_drain_join"], counts["packed_drain_spawn"]);
            assert_eq!(
                plain_counts["packed_drain_join"],
                plain_counts["packed_drain_spawn"]
            );
        } else {
            assert_eq!(counts["inflate"], 4);
            assert_eq!(plain_counts["inflate"], 30);
        }
    }

    #[test]
    fn complete_export_reuses_loose_representations_after_every_current_read() {
        assert_reused_export(false);
    }

    #[test]
    fn complete_export_reuses_packed_representations_after_every_current_read() {
        assert_reused_export(true);
    }

    fn fixture_object_path(fixture: &ReuseFixture, id: &str) -> PathBuf {
        fixture.store.join(&id[..2]).join(&id[2..])
    }

    fn export_after_warm_mutation(
        fixture: &ReuseFixture,
        mutate: impl FnMut(usize) + 'static,
    ) -> Result<OpenCodeNativeSnapshot, TransferError> {
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                before_reference: Some(Box::new(mutate)),
                ..Default::default()
            };
        });
        let result = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")),
        );
        snapshot_reuse_test_hooks::STATE.with(|state| {
            let state = state.borrow();
            assert_eq!(
                state.counts.get("packed_spawn"),
                state.counts.get("packed_reap"),
                "every complete or refused export must join all its exact decoder children"
            );
            assert!(
                state.references >= 2,
                "mutation follows a complete warm closure"
            );
            assert!(
                state.counts.get("hex").copied().unwrap_or(0) >= 3,
                "actual first reference produced a complete representation"
            );
        });
        result
    }

    #[test]
    fn complete_export_warm_missing_roots_preserves_unavailable_references() {
        let fixture = reuse_fixture(false);
        let (baseline, _, _) = reuse_export(&fixture, None);
        let baseline: serde_json::Value =
            serde_json::from_reader(baseline.open_payload().unwrap()).unwrap();
        let roots = fixture
            .trees
            .iter()
            .map(|id| fixture_object_path(&fixture, id))
            .collect::<Vec<_>>();
        let exported = export_after_warm_mutation(&fixture, move |count| {
            if count == 2 {
                for path in &roots {
                    fs::remove_file(path).unwrap();
                }
            }
        })
        .unwrap();
        assert_eq!(exported.manifest().saved_snapshots.len(), 2);
        assert!(exported
            .manifest()
            .saved_snapshots
            .iter()
            .all(|reference| reference.availability
                == SavedSnapshotAvailability::UnavailableInQualifiedLocations
                && reference.objects.is_empty()));
        let payload: serde_json::Value =
            serde_json::from_slice(&fs::read(&exported.payload_path).unwrap()).unwrap();
        assert_eq!(
            payload["rows"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["table"] == "part")
                .count(),
            6
        );
        assert_eq!(
            payload["rows"], baseline["rows"],
            "native history is preserved"
        );
        assert_exported_snapshot_native_readback(&fixture, &exported, "missing-roots");
    }

    #[test]
    fn complete_export_warm_missing_root_preserves_shared_retained_objects() {
        let fixture = reuse_fixture(false);
        let (baseline, _, _) = reuse_export(&fixture, None);
        let baseline: serde_json::Value =
            serde_json::from_reader(baseline.open_payload().unwrap()).unwrap();
        let root = fixture_object_path(&fixture, &fixture.trees[0]);
        let exported = export_after_warm_mutation(&fixture, move |count| {
            if count == 2 {
                fs::remove_file(&root).unwrap();
            }
        })
        .unwrap();
        let references = &exported.manifest().saved_snapshots;
        assert_eq!(references.len(), 2);
        let unavailable = references
            .iter()
            .find(|reference| reference.tree == fixture.trees[0])
            .unwrap();
        assert_eq!(
            unavailable.availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        assert!(unavailable.objects.is_empty());
        let retained = references
            .iter()
            .find(|reference| reference.tree == fixture.trees[1])
            .unwrap();
        assert_eq!(
            retained.availability,
            SavedSnapshotAvailability::RetainedClosure
        );
        assert!(retained
            .objects
            .iter()
            .any(|object| object.object_id == fixture.blob));
        let payload: serde_json::Value =
            serde_json::from_reader(exported.open_payload().unwrap()).unwrap();
        assert_eq!(
            payload["rows"], baseline["rows"],
            "native history is preserved"
        );
        assert_exported_snapshot_native_readback(&fixture, &exported, "shared-retained-objects");
    }

    #[test]
    fn complete_export_warm_child_mutations_refuse_without_publication() {
        for change in [
            "missing",
            "corrupt",
            "wrong_id",
            #[cfg(unix)]
            "redirected",
            "disallowed_alternate",
        ] {
            let fixture = reuse_fixture(false);
            let child = fixture_object_path(&fixture, &fixture.blob);
            let other = fs::read(fixture_object_path(&fixture, &fixture.trees[0])).unwrap();
            let store = fixture.store.clone();
            let outside = fixture.dir.path().join("outside");
            fs::create_dir(&outside).unwrap();
            let result = export_after_warm_mutation(&fixture, move |count| {
                if count != 2 {
                    return;
                }
                match change {
                    "missing" => fs::remove_file(&child).unwrap(),
                    "corrupt" => {
                        fs::remove_file(&child).unwrap();
                        fs::write(&child, b"corrupt zlib").unwrap();
                    }
                    "wrong_id" => {
                        fs::remove_file(&child).unwrap();
                        fs::write(&child, &other).unwrap();
                    }
                    #[cfg(unix)]
                    "redirected" => {
                        let target = outside.join("object");
                        fs::rename(&child, &target).unwrap();
                        std::os::unix::fs::symlink(&target, &child).unwrap();
                    }
                    "disallowed_alternate" => {
                        fs::create_dir_all(store.join("info")).unwrap();
                        fs::write(
                            store.join("info/alternates"),
                            format!("{}\n", outside.display()),
                        )
                        .unwrap();
                    }
                    _ => unreachable!(),
                }
            });
            assert!(
                matches!(
                    result,
                    Err(TransferError::Blocked(_) | TransferError::Io(_))
                ),
                "{change}: {:?}",
                result.as_ref().err()
            );
            assert_eq!(
                fs::read_dir(fixture.dir.path().join("extract"))
                    .unwrap()
                    .count(),
                0,
                "refusal must not publish or retain a bundle"
            );
        }
    }

    #[test]
    fn complete_export_warm_valid_encoding_change_updates_current_commitments() {
        let fixture = reuse_fixture(false);
        let child = fixture_object_path(&fixture, &fixture.blob);
        let original = fs::read(&child).unwrap();
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(original.as_slice())
            .read_to_end(&mut raw)
            .unwrap();
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
        encoder.write_all(&raw).unwrap();
        let changed = encoder.finish().unwrap();
        assert_ne!(original, changed);
        let changed_for_callback = changed.clone();
        let child_for_callback = child.clone();
        let warmed = export_after_warm_mutation(&fixture, move |count| {
            if count == 2 {
                fs::remove_file(&child_for_callback).unwrap();
                fs::write(&child_for_callback, &changed_for_callback).unwrap();
            }
        })
        .unwrap();
        let (uncached, _, _) = reuse_export(&fixture, Some(0));
        assert_eq!(
            fs::read(&warmed.payload_path).unwrap(),
            fs::read(&uncached.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(warmed.manifest()).unwrap(),
            serde_json::to_value(uncached.manifest()).unwrap()
        );
        for reference in &warmed.manifest().saved_snapshots {
            let metadata = reference
                .objects
                .iter()
                .find(|object| object.object_id == fixture.blob)
                .unwrap();
            assert_eq!(metadata.compressed_sha256, digest(&changed));
            assert_eq!(metadata.compressed_bytes, changed.len() as u64);
        }
    }

    fn with_fixture_resolver(fixture: &ReuseFixture, run: impl FnOnce(&mut AssetResolver<'_>)) {
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let db = open_source_read_only(&fixture.inventory.default_database).unwrap();
        let rows = collect_exact_closure(&db, "ses_exact").unwrap();
        let mounts =
            resolve_workspace_mounts(&rows, &fixture.inventory.workspace_mounts, &[]).unwrap();
        let mut resolver = AssetResolver::new(
            fixture
                .inventory
                .tool_output_directory(&fixture.inventory.default_database),
            &mounts,
        );
        resolver.snapshot_data_home = Some(
            fixture
                .inventory
                .default_database
                .parent()
                .unwrap()
                .to_path_buf(),
        );
        resolver
            .snapshot_projects
            .insert("ses_exact".into(), "prj".into());
        run(&mut resolver);
    }

    #[test]
    fn warm_hit_closure_enforces_complete_byte_bound_and_current_edge_kind() {
        let fixture = reuse_fixture(false);
        with_fixture_resolver(&fixture, |resolver| {
            resolver
                .record_saved_snapshot(&fixture.trees[0], "ses_exact")
                .unwrap();
            let bytes = resolver.saved_snapshots[&("ses_exact".into(), fixture.trees[0].clone())]
                .objects
                .iter()
                .map(|object| object.compressed_bytes)
                .sum::<u64>();
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            snapshot_reuse_test_hooks::STATE
                .with(|state| state.borrow_mut().closure_bound = Some(bytes - 1));
            assert!(
                matches!(resolver.record_saved_snapshot(&fixture.trees[0], "ses_exact"), Err(TransferError::Blocked(reason)) if reason == "snapshot closure exceeds its encoded transfer bound")
            );
            assert_eq!(
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone()),
                counts,
                "bound applies while every object representation is resident"
            );
            snapshot_reuse_test_hooks::STATE.with(|state| state.borrow_mut().closure_bound = None);
            let child_tree = resolver
                .object_representations
                .resident
                .values()
                .find(|object| {
                    object.edges.is_tree && object.metadata.object_id != fixture.trees[0]
                })
                .unwrap()
                .metadata
                .object_id
                .clone();
            let mut body = b"100644 wrong-kind\0".to_vec();
            body.extend_from_slice(&hex::decode(child_tree).unwrap());
            let mut raw = format!("tree {}\0", body.len()).into_bytes();
            raw.extend_from_slice(&body);
            let id = hex::encode(sha1::Sha1::digest(&raw));
            let compressed = compress_snapshot_object("tree", &body).unwrap();
            let path = fixture_object_path(&fixture, &id);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, compressed).unwrap();
            assert!(
                matches!(resolver.record_saved_snapshot(&id, "ses_exact"), Err(TransferError::Blocked(reason)) if reason == "snapshot closure object kind differs from its tree edge")
            );
        });
    }

    #[test]
    fn complete_export_warm_packed_store_changes_remain_authoritative() {
        for change in [
            "missing",
            "corrupt",
            #[cfg(unix)]
            "redirected",
        ] {
            let fixture = reuse_fixture(true);
            let pack_directory = fixture.store.join("pack");
            let pack_files = fs::read_dir(&pack_directory)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            #[cfg(unix)]
            let outside = fixture.dir.path().join("outside-pack");
            let result = export_after_warm_mutation(&fixture, move |count| {
                if count != 2 {
                    return;
                }
                match change {
                    "missing" => {
                        for path in &pack_files {
                            fs::remove_file(path).unwrap();
                        }
                    }
                    "corrupt" => {
                        for path in pack_files.iter().filter(|path| {
                            path.extension()
                                .is_some_and(|extension| extension == "pack")
                        }) {
                            let mut bytes = fs::read(path).unwrap();
                            bytes[13] ^= 0xff;
                            fs::remove_file(path).unwrap();
                            fs::write(path, bytes).unwrap();
                        }
                    }
                    #[cfg(unix)]
                    "redirected" => {
                        fs::rename(&pack_directory, &outside).unwrap();
                        std::os::unix::fs::symlink(&outside, &pack_directory).unwrap();
                    }
                    _ => unreachable!(),
                }
            });
            if change == "missing" {
                let exported = result.unwrap();
                assert!(exported
                    .manifest()
                    .saved_snapshots
                    .iter()
                    .all(|reference| reference.availability
                        == SavedSnapshotAvailability::UnavailableInQualifiedLocations));
            } else {
                assert!(
                    matches!(
                        result,
                        Err(TransferError::Blocked(_) | TransferError::Io(_))
                    ),
                    "{change}: {:?}",
                    result.as_ref().err()
                );
                assert_eq!(
                    fs::read_dir(fixture.dir.path().join("extract"))
                        .unwrap()
                        .count(),
                    0
                );
            }
        }
    }

    #[cfg(unix)]
    fn observation_fixture() -> (ReuseFixture, Vec<PathBuf>, String, Vec<u8>) {
        let fixture = reuse_fixture(true);
        let (_, id, body) = packed_pressure_stores(&fixture);
        let workspace = fixture.dir.path().join("workspace/.git");
        fs::create_dir(&workspace).unwrap();
        fixture_git(&workspace, &["init", "--bare", "-q"], None);
        // An empty pack directory and a missing pack directory both participate
        // in the complete ordered current plan, including duplicate locations.
        let empty = fixture.dir.path().join("workspace/empty");
        fs::create_dir(&empty).unwrap();
        fixture_git(&empty, &["init", "--bare", "-q"], None);
        let absent = fixture.dir.path().join("workspace/absent");
        fs::create_dir(&absent).unwrap();
        fixture_git(&absent, &["init", "--bare", "-q"], None);
        fs::remove_dir(absent.join("objects/pack")).unwrap();
        fs::write(absent.join("objects/info/alternates"), "\n").unwrap();
        let file = fixture.store.join("info/alternates");
        let mut alternates = fs::read_to_string(&file).unwrap();
        alternates.push_str(&format!(
            "{}\n{}\n{}\n",
            empty.join("objects").display(),
            absent.join("objects").display(),
            empty.join("objects").display()
        ));
        fs::write(file, alternates).unwrap();
        fs::write(fixture.store.parent().unwrap().join("commondir"), ".\n").unwrap();
        let stores =
            qualified_snapshot_stores(fixture.store.parent().unwrap(), &workspace.join("objects"))
                .unwrap();
        assert_eq!(stores.len(), 10);
        (fixture, stores, id, body)
    }

    #[cfg(unix)]
    fn observation_operation_count(counts: &BTreeMap<&'static str, usize>) -> usize {
        [
            "fs_lstat",
            "fs_canonicalize",
            "fs_stat",
            "fs_read",
            "fs_read_dir",
        ]
        .iter()
        .map(|key| counts.get(key).copied().unwrap_or(0))
        .sum()
    }

    #[cfg(unix)]
    fn observation_reader(
        fixture: &ReuseFixture,
        stores: &[PathBuf],
        id: &str,
        body: &[u8],
        legacy: bool,
    ) -> (Vec<SnapshotStorageStamp>, BTreeMap<&'static str, usize>) {
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                legacy_observation: legacy,
                ..Default::default()
            }
        });
        let mut decoders = SnapshotPackedDecoders::default();
        decoders
            .qualify(
                fixture.store.parent().unwrap(),
                &fixture.dir.path().join("workspace/.git/objects"),
                stores,
            )
            .unwrap();
        for _ in 0..4 {
            let Some(SnapshotObjectSource::Packed { body: current, .. }) =
                decoders.read(stores, id).unwrap()
            else {
                panic!("current real packed object");
            };
            assert_eq!(current, body);
        }
        assert_eq!(decoders.costs.fresh_inspections, 4);
        assert_eq!(decoders.costs.native_queries, 4);
        let storage = decoders.storage.take().unwrap();
        decoders.finish().unwrap();
        let counts = snapshot_reuse_test_hooks::take_observation_counts();
        assert_eq!(counts["packed_validate"], 4);
        assert_eq!(counts["packed_spawn"], counts["packed_reap"]);
        assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
        (storage, counts)
    }

    #[cfg(unix)]
    #[test]
    fn fresh_snapshot_observation_shares_actual_filesystem_acquisitions() {
        let (fixture, stores, id, body) = observation_fixture();
        let reference_plan = qualified_snapshot_stores(
            fixture.store.parent().unwrap(),
            &fixture.dir.path().join("workspace/.git/objects"),
        )
        .unwrap();
        assert_eq!(stores, reference_plan);
        let reference_stamps = legacy_snapshot_packed_storage(&stores).unwrap();
        let (fresh_plan, fresh_stamps) = observe_current_snapshot_sources(
            fixture.store.parent().unwrap(),
            &fixture.dir.path().join("workspace/.git/objects"),
        )
        .unwrap();
        assert_eq!(fresh_plan, reference_plan);
        assert_eq!(fresh_stamps, reference_stamps);
        let (old_stamps, old_counts) = observation_reader(&fixture, &stores, &id, &body, true);
        let (new_stamps, new_counts) = observation_reader(&fixture, &stores, &id, &body, false);
        assert_eq!(old_stamps, reference_stamps);
        assert_eq!(
            new_stamps, reference_stamps,
            "all fields, paths, ordering, duplicate locations and context bytes remain current"
        );
        for key in [
            "packed_query",
            "packed_validate",
            "packed_spawn",
            "packed_reap",
            "packed_drain_spawn",
            "packed_drain_join",
        ] {
            assert_eq!(old_counts[key], new_counts[key], "{key}");
        }
        eprintln!("actual observation operations: legacy={old_counts:?} shared={new_counts:?}");
        assert!(
            observation_operation_count(&new_counts) < observation_operation_count(&old_counts),
            "same-query duplicate filesystem acquisitions must decrease"
        );
    }

    #[cfg(unix)]
    fn observation_export(
        fixture: &ReuseFixture,
        legacy: bool,
    ) -> (OpenCodeNativeSnapshot, BTreeMap<&'static str, usize>) {
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                legacy_observation: legacy,
                budget: Some(0),
                ..Default::default()
            }
        });
        let snapshot = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")),
        )
        .unwrap();
        let counts = snapshot_reuse_test_hooks::take_observation_counts();
        (snapshot, counts)
    }

    #[cfg(unix)]
    #[test]
    fn fresh_snapshot_observation_preserves_complete_native_export() {
        let (fixture, _, _, _) = observation_fixture();
        let (old, old_counts) = observation_export(&fixture, true);
        let (new, new_counts) = observation_export(&fixture, false);
        assert_eq!(
            fs::read(&old.payload_path).unwrap(),
            fs::read(&new.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(old.manifest()).unwrap(),
            serde_json::to_value(new.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(old.manifest()).unwrap(),
            source_graph_fingerprint(new.manifest()).unwrap()
        );
        for key in [
            "packed_query",
            "packed_validate",
            "packed_spawn",
            "packed_reap",
            "packed_drain_spawn",
            "packed_drain_join",
        ] {
            assert_eq!(old_counts[key], new_counts[key], "{key}");
        }
        assert_eq!(new_counts["packed_query"], 30);
        eprintln!(
            "complete export actual observation operations: legacy={} shared={}",
            observation_operation_count(&old_counts),
            observation_operation_count(&new_counts)
        );
        assert!(
            observation_operation_count(&new_counts) < observation_operation_count(&old_counts),
            "full exports must use shared fresh acquisitions without losing native proof"
        );
        // Both actual payloads also pass the unchanged production snapshot
        // installer and current closure reader, and ordinary native Git reads
        // the installed tree. No fixture decoder substitutes for that read.
        for (name, snapshot) in [("old", &old), ("new", &new)] {
            let payload: serde_json::Value =
                serde_json::from_slice(&fs::read(&snapshot.payload_path).unwrap()).unwrap();
            let objects: Vec<SerializedSnapshotObject> =
                serde_json::from_value(payload["snapshot_objects"].clone()).unwrap();
            let destination = fixture.dir.path().join(name).join("opencode.db");
            for object in &objects {
                install_snapshot_object(object, &snapshot.manifest().saved_snapshots, &destination)
                    .unwrap();
            }
            for reference in &snapshot.manifest().saved_snapshots {
                let bucket = destination
                    .parent()
                    .unwrap()
                    .join("snapshot")
                    .join(&reference.project_id)
                    .join(&reference.worktree_sha1);
                let stores = qualified_snapshot_stores(&bucket, &bucket.join("objects")).unwrap();
                let closure = read_snapshot_closure(&stores, &reference.tree)
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    closure.keys().collect::<BTreeSet<_>>(),
                    reference
                        .objects
                        .iter()
                        .map(|object| &object.object_id)
                        .collect::<BTreeSet<_>>()
                );
                assert_eq!(
                    fixture_git(&bucket, &["cat-file", "-p", &reference.tree], None),
                    fixture_git(
                        fixture.store.parent().unwrap(),
                        &["cat-file", "-p", &reference.tree],
                        None
                    )
                );
            }
        }
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    fn observation_handoff_target(
        fixture: &ReuseFixture,
        stores: &[PathBuf],
        mutation: &str,
    ) -> (&'static str, PathBuf) {
        match mutation {
            "store_replace" | "store_redirect" => ("store_binding", fixture.store.clone()),
            "store_final_permissions" => ("store_final_binding", fixture.store.clone()),
            "pack_replace" | "pack_redirect" => ("pack_binding", fixture.store.join("pack")),
            "index_replace" | "index_remove" | "next_pack_remove" => (
                "pack_binding",
                packed_file(&fixture.store).with_extension("idx"),
            ),
            "pack_file_replace" => ("pack_binding", packed_file(&fixture.store)),
            "config_bytes" | "config_replace" | "config_remove" => (
                "context_bytes",
                fixture.store.parent().unwrap().join("config"),
            ),
            "common_absent" => (
                "context_bytes",
                stores[0].parent().unwrap().join("commondir"),
            ),
            "alternate_bytes" => ("context_bytes", fixture.store.join("info/alternates")),
            "nested_absent" => ("context_bytes", stores[0].join("info/alternates")),
            _ => panic!("unknown owned mutation"),
        }
    }

    #[cfg(unix)]
    fn mutate_observation_handoff(path: &Path, mutation: &str) {
        use std::os::unix::fs::{symlink, PermissionsExt};
        match mutation {
            "store_final_permissions" => {
                let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
                fs::set_permissions(
                    path,
                    fs::Permissions::from_mode(if mode == 0o700 { 0o750 } else { 0o700 }),
                )
                .unwrap();
            }
            "store_replace" | "store_redirect" | "pack_replace" | "pack_redirect" => {
                let original = path.with_extension("owned-original");
                fs::rename(path, &original).unwrap();
                if mutation.ends_with("redirect") {
                    symlink(original, path).unwrap();
                } else {
                    fs::create_dir(path).unwrap();
                }
            }
            "config_bytes" | "alternate_bytes" => {
                let mut bytes = fs::read(path).unwrap();
                bytes.extend_from_slice(if mutation == "config_bytes" {
                    b"\n# unchanged effective config\n"
                } else {
                    b"\n"
                });
                fs::write(path, bytes).unwrap();
            }
            "common_absent" => fs::write(path, ".\n").unwrap(),
            "nested_absent" => fs::write(path, "../outside\n").unwrap(),
            "next_pack_remove" => fs::remove_file(path.with_extension("pack")).unwrap(),
            "config_remove" | "index_remove" => fs::remove_file(path).unwrap(),
            "index_replace" | "pack_file_replace" | "config_replace" => {
                let replacement = path.with_extension("owned-replacement");
                fs::copy(path, &replacement).unwrap();
                fs::rename(replacement, path).unwrap();
            }
            _ => panic!("unknown owned mutation"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn fresh_snapshot_observation_refuses_binding_and_byte_handoff_mutations() {
        for mutation in [
            "store_replace",
            "store_final_permissions",
            "store_redirect",
            "pack_replace",
            "pack_redirect",
            "index_replace",
            "index_remove",
            "next_pack_remove",
            "pack_file_replace",
            "config_bytes",
            "config_replace",
            "config_remove",
            "common_absent",
            "alternate_bytes",
            "nested_absent",
        ] {
            let (fixture, stores, id, body) = observation_fixture();
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let mut decoders = SnapshotPackedDecoders::default();
            decoders
                .qualify(
                    fixture.store.parent().unwrap(),
                    &fixture.dir.path().join("workspace/.git/objects"),
                    &stores,
                )
                .unwrap();
            let Some(SnapshotObjectSource::Packed { body: current, .. }) =
                decoders.read(&stores, &id).unwrap()
            else {
                panic!("real warm packed query");
            };
            assert_eq!(current, body);
            let (phase, target) = observation_handoff_target(&fixture, &stores, mutation);
            let calls = std::rc::Rc::new(std::cell::Cell::new(0));
            let observed_calls = calls.clone();
            snapshot_reuse_test_hooks::STATE.with(|state| {
                state.borrow_mut().observation_barrier =
                    Some(Box::new(move |current_phase, path| {
                        if current_phase == phase && path == target && observed_calls.get() == 0 {
                            observed_calls.set(1);
                            mutate_observation_handoff(path, mutation);
                        }
                    }))
            });
            let result = decoders.read(&stores, &id);
            assert_eq!(
                calls.get(),
                1,
                "{mutation}: actual acquisition handoff executes"
            );
            assert!(
                result.is_err(),
                "{mutation}: changed binding or context must refuse before another native proof"
            );
            if mutation == "next_pack_remove" {
                assert!(
                    matches!(result, Err(TransferError::Io(_))),
                    "an enumerated file that disappears must preserve its I/O refusal class"
                );
            }
            assert_eq!(
                decoders.costs.fresh_inspections, 2,
                "{mutation}: still observes this query"
            );
            assert_eq!(
                decoders.costs.native_queries, 1,
                "{mutation}: no native query may follow a failed current observation"
            );
            decoders.finish().unwrap();
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    #[test]
    fn fresh_snapshot_observation_handoff_refuses_complete_bundle_publication() {
        for mutation in [
            "store_redirect",
            "pack_file_replace",
            "config_bytes",
            "alternate_bytes",
            "nested_absent",
        ] {
            let (fixture, stores, _, _) = observation_fixture();
            let (phase, target) = observation_handoff_target(&fixture, &stores, mutation);
            let warm = std::rc::Rc::new(std::cell::Cell::new(false));
            let warmed = warm.clone();
            let calls = std::rc::Rc::new(std::cell::Cell::new(0));
            let observed_calls = calls.clone();
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    before_reference: Some(Box::new(move |number| {
                        if number == 2 {
                            warmed.set(true);
                        }
                    })),
                    observation_barrier: Some(Box::new(move |current_phase, path| {
                        if warm.get()
                            && current_phase == phase
                            && path == target
                            && observed_calls.get() == 0
                        {
                            observed_calls.set(1);
                            mutate_observation_handoff(path, mutation);
                        }
                    })),
                    ..Default::default()
                }
            });
            let result = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            );
            assert_eq!(calls.get(), 1, "{mutation}");
            assert!(
                result.is_err(),
                "{mutation}: no complete bundle with expired observation"
            );
            assert_eq!(
                fs::read_dir(fixture.dir.path().join("extract"))
                    .unwrap()
                    .count(),
                0,
                "{mutation}: failed capture cannot publish even a partial bundle"
            );
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    #[test]
    fn fresh_snapshot_observation_observes_warm_ordered_plan_drift_and_loose_precedence() {
        for mutation in [
            "store_absent",
            "parent_redirect",
            "pack_entry_directory",
            "alternate_order",
            "alternate_nested",
            "alternate_outside",
            "selected_loose",
        ] {
            let (fixture, stores, id, body) = observation_fixture();
            if mutation == "parent_redirect" {
                // The selected object lives in an alternate. An absent primary
                // pack does not exempt that store's exact lexical binding.
                fs::remove_dir_all(fixture.store.join("pack")).unwrap();
            }
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let mut decoders = SnapshotPackedDecoders::default();
            decoders
                .qualify(
                    fixture.store.parent().unwrap(),
                    &fixture.dir.path().join("workspace/.git/objects"),
                    &stores,
                )
                .unwrap();
            let Some(SnapshotObjectSource::Packed { body: current, .. }) =
                decoders.read(&stores, &id).unwrap()
            else {
                panic!("warm query");
            };
            assert_eq!(current, body);
            match mutation {
                "store_absent" => {
                    fs::rename(&fixture.store, fixture.store.with_extension("owned-absent"))
                        .unwrap()
                }
                "parent_redirect" => {
                    let native = fixture.store.parent().unwrap();
                    let original = native.with_extension("owned-original");
                    fs::rename(native, &original).unwrap();
                    std::os::unix::fs::symlink(original, native).unwrap();
                }
                "pack_entry_directory" => {
                    fs::create_dir(fixture.store.join("pack/owned-entry")).unwrap()
                }
                "alternate_order" => {
                    let file = fixture.store.join("info/alternates");
                    let bytes = fs::read_to_string(&file).unwrap();
                    fs::write(
                        file,
                        bytes
                            .lines()
                            .rev()
                            .map(|line| format!("{line}\n"))
                            .collect::<String>(),
                    )
                    .unwrap();
                }
                "alternate_nested" => fs::write(
                    stores[0].join("info/alternates"),
                    format!("{}\n", stores[1].display()),
                )
                .unwrap(),
                "alternate_outside" => fs::write(
                    fixture.store.join("info/alternates"),
                    format!("{}\n", fixture.store.display()),
                )
                .unwrap(),
                "selected_loose" => {
                    let path = stores[0].join(&id[..2]).join(&id[2..]);
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(
                        path,
                        compress_snapshot_object("blob", b"current wrong loose duplicate").unwrap(),
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            let result = decoders.read(&stores, &id);
            if mutation == "selected_loose" {
                let Some(SnapshotObjectSource::Loose(bytes)) = result.unwrap() else {
                    panic!("current loose must precede warm pack");
                };
                assert!(
                    decode_snapshot_object(&id, &bytes).is_err(),
                    "wrong current loose body must fail native identity proof"
                );
            } else {
                assert!(
                    result.is_err(),
                    "{mutation}: all current locations/context remain mandatory"
                );
            }
            assert_eq!(
                decoders.costs.native_queries, 1,
                "{mutation}: no warm packed proof can bypass current state"
            );
            decoders.finish().unwrap();
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    fn packed_file(store: &Path) -> PathBuf {
        fs::read_dir(store.join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "pack")
            })
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_accepts_only_current_proved_duplicate_bodies() {
        // Retain184's actual complete qualified wrong-body fixture. Its old
        // both-direction equivalence FAIL remains evidence; this test protects
        // the assessed correct-content success contract, not duplicate health.
        let fixture = reuse_fixture(true);
        let (stores, late_id, body) = packed_pressure_stores(&fixture);
        let earlier = stores[1].parent().unwrap();
        assert_eq!(
            fixture_git(earlier, &["hash-object", "-w", "--stdin"], Some(&body)),
            late_id
        );
        fixture_git(
            earlier,
            &["update-ref", "refs/fixture/object", &late_id],
            None,
        );
        fixture_git(earlier, &["repack", "-a", "-d"], None);
        fixture_git(earlier, &["prune-packed"], None);
        let corrupt = |store: &Path| {
            let path = packed_file(store);
            let original = fs::read(&path).unwrap();
            let mut replacement = fs::read(packed_file(&stores[2])).unwrap();
            assert_eq!(replacement.len(), original.len());
            let end = replacement.len();
            replacement[end - 20..].copy_from_slice(&original[original.len() - 20..]);
            fs::remove_file(&path).unwrap();
            fs::write(path, replacement).unwrap();
        };
        corrupt(&stores[1]);
        // Native Git sorts pack candidates by mtime before alternate order.
        // Give the disposable packs one stable timestamp so this regression
        // executes184's two opposite selected-copy orders deterministically.
        for store in &stores {
            for entry in fs::read_dir(store.join("pack")).unwrap() {
                File::open(entry.unwrap().path())
                    .unwrap()
                    .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000))
                    .unwrap();
            }
        }
        let native = fixture.store.parent().unwrap();
        let workspace = fixture.dir.path().join("workspace/.git/objects");
        for reversed in [false, true] {
            let mut ordered = stores.clone();
            if reversed {
                ordered.swap(1, 4);
            }
            fs::write(
                fixture.store.join("info/alternates"),
                ordered[..5]
                    .iter()
                    .map(|path| format!("{}\n", path.display()))
                    .collect::<String>(),
            )
            .unwrap();
            let qualified = qualified_snapshot_stores(native, &workspace).unwrap();
            assert_eq!(qualified, ordered);
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    aggregate_disabled: true,
                    ..Default::default()
                }
            });
            let baseline = read_snapshot_object(&qualified, &late_id);
            assert_eq!(
                baseline.is_err(),
                !reversed,
                "preserve184's observed baseline, not claim its failure was green"
            );
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let mut decoders = SnapshotPackedDecoders::default();
            decoders.qualify(native, &workspace, &qualified).unwrap();
            let Some(SnapshotObjectSource::Packed {
                kind,
                body: current,
            }) = decoders.read(&qualified, &late_id).unwrap()
            else {
                panic!("a freshly proved valid representation may succeed despite an unselected corrupt duplicate");
            };
            assert_eq!(kind, "blob");
            assert_eq!(current, body);
            decoders.finish().unwrap();
            assert_eq!(decoders.costs.aggregate_rejections, u64::from(reversed));
            assert_eq!(decoders.costs.aggregate_fallbacks, u64::from(reversed));
            assert_settled_native_fixture();
        }
        corrupt(&stores[4]);
        let qualified = qualified_snapshot_stores(native, &workspace).unwrap();
        let mut decoders = SnapshotPackedDecoders::default();
        decoders.qualify(native, &workspace, &qualified).unwrap();
        assert!(
            decoders.read(&qualified, &late_id).is_err(),
            "all wrong bodies remain refused"
        );
        decoders.finish().unwrap();
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    fn assert_settled_native_fixture() {
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(
            counts.get("packed_spawn").copied().unwrap_or(0),
            counts.get("packed_reap").copied().unwrap_or(0)
        );
        assert_eq!(
            counts.get("packed_drain_spawn").copied().unwrap_or(0),
            counts.get("packed_drain_join").copied().unwrap_or(0)
        );
        assert!(counts.get("packed_peak").copied().unwrap_or(0) <= MAX_RESIDENT_SNAPSHOT_DECODERS);
        assert!(
            counts.get("packed_drain_peak").copied().unwrap_or(0) <= MAX_RESIDENT_SNAPSHOT_DECODERS
        );
    }

    #[cfg(unix)]
    fn response_fixture(body: Option<&[u8]>, exit: i32, trailing: bool) -> SnapshotPackedDecoder {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                r#"while IFS= read -r oid; do
            if [ "$1" = missing ]; then printf '%s missing\n' "$oid";
            else printf '%s blob %s\n%s\n' "$oid" "$2" "$1"; fi
            done
            if [ "$4" = yes ]; then printf '%s' 'unsolicited trailing output'; fi
            exit "$3""#,
            )
            .arg("owned-aggregate-response-fixture")
            .arg(
                body.map(|body| std::str::from_utf8(body).unwrap())
                    .unwrap_or("missing"),
            )
            .arg(body.map_or(0, <[u8]>::len).to_string())
            .arg(exit.to_string())
            .arg(if trailing { "yes" } else { "no" });
        SnapshotPackedDecoder::from_command(command).unwrap()
    }

    #[cfg(unix)]
    fn injected_aggregate(
        stores: &[PathBuf],
        response: SnapshotPackedDecoder,
    ) -> SnapshotPackedDecoders {
        SnapshotPackedDecoders {
            aggregate: Some(response),
            storage: Some(snapshot_packed_storage(stores).unwrap()),
            ..Default::default()
        }
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_misses_require_current_bounded_fallback() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, body) = packed_pressure_stores(&fixture);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let mut decoders = injected_aggregate(&stores, response_fixture(None, 0, false));
        let Some(SnapshotObjectSource::Packed { body: current, .. }) =
            decoders.read(&stores, &late_id).unwrap()
        else {
            panic!("a false aggregate miss must use independent current fallback");
        };
        assert_eq!(current, body);
        assert!(decoders.aggregate.is_none());
        assert_eq!(decoders.costs.aggregate_fallbacks, 1);
        assert_eq!(decoders.costs.native_queries, 1 + (stores.len() - 1) as u64);
        let absent = "0".repeat(40);
        for _ in 0..4 {
            assert!(decoders.read(&stores, &absent).unwrap().is_none());
            assert!(decoders.aggregate.is_none());
            assert!(decoders.children.len() <= MAX_RESIDENT_SNAPSHOT_DECODERS);
        }
        assert_eq!(
            decoders.costs.aggregate_fallbacks, 5,
            "no cached absence skips later current fallback"
        );
        assert_eq!(decoders.costs.aggregate_rejections, 0);
        assert_eq!(decoders.costs.fresh_inspections, 5);
        decoders.finish().unwrap();
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_late_failures_refuse_before_fallback_or_publication() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, body) = packed_pressure_stores(&fixture);
        for (valid, exit, trailing, drain_failed) in [
            (false, 9, false, false),
            (false, 0, true, false),
            (true, 9, false, false),
            (true, 0, true, false),
            (false, 0, false, true),
            (true, 0, false, true),
        ] {
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let mut response = response_fixture(valid.then_some(body.as_slice()), exit, trailing);
            if drain_failed {
                let original = response.stderr.take().unwrap();
                response.stderr = Some(std::thread::spawn(move || {
                    original.join().unwrap()?;
                    Err(io::Error::other("owned fixture stderr drain failure"))
                }));
            }
            let mut decoders = injected_aggregate(&stores, response);
            let result = decoders.read(&stores, &late_id);
            if valid {
                assert!(result.unwrap().is_some());
                let mounts = HashMap::new();
                let mut resolver =
                    AssetResolver::new(fixture.dir.path().join("owned-output"), &mounts);
                resolver.packed_decoders = decoders;
                assert!(resolver.resolve_rows(&mut []).is_err(),
                    "the actual export resolver completion boundary refuses late failure after valid bytes");
            } else {
                assert!(
                    result.is_err(),
                    "late aggregate failure cannot be recovered by fallback"
                );
                assert!(decoders.children.is_empty());
                decoders.finish().unwrap();
            }
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(
                counts["packed_spawn"], 1,
                "no fallback spawn precedes failed aggregate settlement"
            );
            assert_settled_native_fixture();
        }
        // A clean miss may leave fallback owners. Their late error must settle
        // before a later aggregate can open or return otherwise valid bytes.
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let mut decoders = SnapshotPackedDecoders {
            storage: Some(snapshot_packed_storage(&stores).unwrap()),
            ..Default::default()
        };
        decoders
            .children
            .insert(stores[0].clone(), response_fixture(None, 9, false));
        assert!(decoders.read(&stores, &late_id).is_err());
        assert!(decoders.aggregate.is_none());
        decoders.finish().unwrap();
        assert_eq!(
            snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts["packed_spawn"]),
            1
        );
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_preserves_native_unix_path_bytes() {
        use std::os::unix::ffi::OsStringExt;
        for name in [
            b"space in path".as_slice(),
            b"colon:path",
            b"quote\"path",
            b"back\\slash",
            b"native-\xff",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let native = dir.path().join("native");
            let workspace = dir.path().join(std::ffi::OsString::from_vec(name.to_vec()));
            let git_dir = workspace.join(".git");
            fs::create_dir_all(&native).unwrap();
            fs::create_dir_all(&git_dir).unwrap();
            for (git, body) in [
                (&native, b"unrelated native object".as_slice()),
                (&git_dir, b"current path object"),
            ] {
                fixture_git(git, &["init", "--bare", "-q"], None);
                let id = fixture_git(git, &["hash-object", "-w", "--stdin"], Some(body));
                fixture_git(git, &["update-ref", "refs/fixture/object", &id], None);
                fixture_git(git, &["repack", "-a", "-d"], None);
                fixture_git(git, &["prune-packed"], None);
            }
            let id = fixture_git(&git_dir, &["rev-parse", "refs/fixture/object"], None);
            let stores = qualified_snapshot_stores(&native, &git_dir.join("objects")).unwrap();
            assert_eq!(stores.len(), 2);
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let mut decoders = SnapshotPackedDecoders::default();
            decoders
                .qualify(&native, &git_dir.join("objects"), &stores)
                .unwrap();
            let Some(SnapshotObjectSource::Packed { body, .. }) =
                decoders.read(&stores, &id).unwrap()
            else {
                panic!("native path bytes must reach the correct qualified store");
            };
            assert_eq!(body, b"current path object");
            assert_eq!(decoders.costs.aggregate_fallbacks, 0);
            decoders.finish().unwrap();
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_replaced_pack_cannot_supply_retired_bytes() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, body) = packed_pressure_stores(&fixture);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let mut decoders = SnapshotPackedDecoders::default();
        let workspace = fixture.dir.path().join("workspace/.git/objects");
        decoders
            .qualify(fixture.store.parent().unwrap(), &workspace, &stores)
            .unwrap();
        let Some(SnapshotObjectSource::Packed { body: current, .. }) =
            decoders.read(&stores, &late_id).unwrap()
        else {
            panic!("warm actual aggregate");
        };
        assert_eq!(current, body);
        assert!(decoders.aggregate.is_some());
        let replacements = fs::read_dir(stores[0].join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        for entry in fs::read_dir(stores[4].join("pack")).unwrap() {
            let original = entry.unwrap().path();
            let replacement = replacements
                .iter()
                .find(|path| path.extension() == original.extension())
                .unwrap();
            fs::remove_file(&original).unwrap();
            fs::copy(replacement, original).unwrap();
        }
        assert!(
            decoders.read(&stores, &late_id).unwrap().is_none(),
            "all-store current stamps must retire aggregate's old open pack descriptors"
        );
        decoders.finish().unwrap();
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_cold_miss_observes_new_pack_and_context_changes() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, late_body) = packed_pressure_stores(&fixture);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let native = fixture.store.parent().unwrap();
        let workspace = fixture.dir.path().join("workspace/.git/objects");
        let mut decoders = SnapshotPackedDecoders::default();
        decoders.qualify(native, &workspace, &stores).unwrap();
        let new_body = b"new aggregate native object after cold miss";
        let mut raw = format!("blob {}\0", new_body.len()).into_bytes();
        raw.extend_from_slice(new_body);
        let id = hex::encode(sha1::Sha1::digest(raw));
        assert!(decoders.read(&stores, &id).unwrap().is_none());
        let git = stores[4].parent().unwrap();
        assert_eq!(
            fixture_git(git, &["hash-object", "-w", "--stdin"], Some(new_body)),
            id
        );
        fixture_git(git, &["update-ref", "refs/fixture/new", &id], None);
        fixture_git(git, &["repack", "-a", "-d"], None);
        fixture_git(git, &["prune-packed"], None);
        let Some(SnapshotObjectSource::Packed { body, .. }) = decoders.read(&stores, &id).unwrap()
        else {
            panic!("fresh new pack replaces negative native state");
        };
        assert_eq!(body, new_body);
        for mutation in 0..4 {
            let before = decoders.costs.native_spawns;
            match mutation {
                0 => {
                    let config = native.join("config");
                    let mut bytes = fs::read(&config).unwrap();
                    bytes.extend_from_slice(b"\n# current fixture context\n");
                    fs::write(config, bytes).unwrap();
                }
                1 => fs::write(native.join("commondir"), ".\n").unwrap(),
                2 => {
                    let alternate = fixture.store.join("info/alternates");
                    let mut bytes = fs::read(&alternate).unwrap();
                    bytes.push(b'\n');
                    fs::write(alternate, bytes).unwrap();
                }
                _ => {
                    let new_workspace = fixture.dir.path().join("workspace/.git2/objects");
                    assert_eq!(
                        qualified_snapshot_stores(native, &new_workspace).unwrap(),
                        stores
                    );
                    decoders.qualify(native, &new_workspace, &stores).unwrap();
                }
            }
            let Some(SnapshotObjectSource::Packed { body, .. }) =
                decoders.read(&stores, &late_id).unwrap()
            else {
                panic!("changed context still independently reads current body");
            };
            assert_eq!(body, late_body);
            assert!(
                decoders.costs.native_spawns > before,
                "changed config/common/alternate/source context must retire previous aggregate"
            );
        }
        drop(decoders);
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_does_not_bypass_wrong_loose_or_uninspected_stores() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for mutation in 0..4 {
            let fixture = reuse_fixture(true);
            let (stores, _, _) = packed_pressure_stores(&fixture);
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let (warm, _, _) = reuse_export(&fixture, None);
            assert_eq!(warm.manifest().saved_snapshots.len(), 2);
            match mutation {
                0 => {
                    let wrong =
                        compress_snapshot_object("blob", b"wrong current loose content").unwrap();
                    let path = stores[0].join(&fixture.blob[..2]).join(&fixture.blob[2..]);
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(path, wrong).unwrap();
                }
                1 => {
                    let pack = stores[2].join("pack");
                    let original = stores[2].join("owned-original-pack");
                    fs::rename(&pack, &original).unwrap();
                    symlink(original, pack).unwrap();
                }
                2 => fs::set_permissions(&stores[2], fs::Permissions::from_mode(0o000)).unwrap(),
                _ => fs::write(
                    fixture.store.join("info/alternates"),
                    format!("{}\n", fixture.dir.path().join("outside/objects").display()),
                )
                .unwrap(),
            }
            let result = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            );
            if mutation == 2 {
                fs::set_permissions(&stores[2], fs::Permissions::from_mode(0o755)).unwrap();
            }
            assert!(
                result.is_err(),
                "current loose identity and every store's qualification remain mandatory"
            );
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_current_inspection_and_query_keep_partial_operation_costs() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, _) = packed_pressure_stores(&fixture);
        let mut decoders =
            injected_aggregate(&stores, response_fixture(Some(b"wrong identity"), 0, false));
        assert!(
            decoders.read(&stores, &late_id).is_ok(),
            "clean rejection may recover exact current body"
        );
        assert_eq!(decoders.costs.aggregate_rejections, 1);
        assert!(decoders.costs.native_query_us > 0);
        let pack = stores[0].join("pack");
        fs::remove_dir_all(&pack).unwrap();
        fs::write(pack, b"not a directory").unwrap();
        assert!(decoders.read(&stores, &late_id).is_err());
        assert_eq!(decoders.costs.fresh_inspections, 2);
        assert!(decoders.costs.fresh_inspection_us > 0);
        decoders.finish().unwrap();
        assert_settled_native_fixture();
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_preserves_missing_root_reference_and_blocks_missing_child() {
        for missing_child in [false, true] {
            let fixture = reuse_fixture(true);
            packed_pressure_stores(&fixture);
            let tree = if missing_child {
                let mut body = b"100644 missing\0".to_vec();
                body.extend_from_slice(&[0x11; 20]);
                let native = fixture.store.parent().unwrap();
                let tree = fixture_git(
                    native,
                    &["hash-object", "-t", "tree", "-w", "--stdin"],
                    Some(&body),
                );
                let prefix = fixture.store.join("pack/pack");
                fixture_git(
                    native,
                    &["pack-objects", prefix.to_str().unwrap()],
                    Some(format!("{tree}\n").as_bytes()),
                );
                fixture_git(native, &["prune-packed"], None);
                assert!(!fixture_object_path(&fixture, &tree).exists());
                tree
            } else {
                "f".repeat(40)
            };
            let database = Connection::open(fixture.dir.path().join("data/opencode.db")).unwrap();
            database
                .execute(
                    "UPDATE session SET revert=?1 WHERE id='ses_exact'",
                    [serde_json::json!({"snapshot":tree}).to_string()],
                )
                .unwrap();
            drop(database);
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            let result = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            );
            if missing_child {
                assert!(matches!(result, Err(TransferError::Blocked(ref reason)) if reason.contains("incomplete tree closure")),
                    "a retained native tree with missing child is never a complete exported closure");
                assert_eq!(
                    fs::read_dir(fixture.dir.path().join("extract"))
                        .unwrap()
                        .count(),
                    0
                );
            } else {
                let exported = result.unwrap();
                let retained = exported
                    .manifest()
                    .saved_snapshots
                    .iter()
                    .find(|reference| reference.tree == tree)
                    .unwrap();
                assert_eq!(retained.session_id, "ses_exact");
                assert_eq!(
                    retained.availability,
                    SavedSnapshotAvailability::UnavailableInQualifiedLocations
                );
                assert!(retained.objects.is_empty());
                assert!(
                    fs::read_to_string(&exported.payload_path)
                        .unwrap()
                        .contains(&tree),
                    "missing root reference is preserved"
                );
            }
            assert_settled_native_fixture();
        }
    }

    #[cfg(unix)]
    #[test]
    fn saved_object_observer_reports_actual_native_reader_costs() {
        let fixture = reuse_fixture(true);
        packed_pressure_stores(&fixture);
        let plain = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")),
        )
        .unwrap();
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let exported = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")).with_progress_observer(
                move |event| {
                    observed
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(event).unwrap());
                },
            ),
        )
        .unwrap();
        assert_eq!(exported.manifest().saved_snapshots.len(), 2);
        assert_eq!(
            fs::read(&plain.payload_path).unwrap(),
            fs::read(&exported.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(plain.manifest()).unwrap(),
            serde_json::to_value(exported.manifest()).unwrap()
        );
        assert_settled_native_fixture();
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        let events = events.lock().unwrap();
        let event = events
            .iter()
            .find(|event| event["phase"] == "saved_objects" && event["state"] == "completed")
            .unwrap();
        assert_eq!(event["completedCount"], 30);
        let costs = &event["readerCosts"];
        assert_eq!(
            costs["freshInspections"].as_u64(),
            Some(30),
            "every current packed occurrence performs fresh source inspection"
        );
        assert_eq!(
            costs["nativeQueries"].as_u64(),
            Some(counts["packed_query"] as u64)
        );
        assert_eq!(
            costs["nativeSpawns"].as_u64(),
            Some(counts["packed_spawn"] as u64)
        );
        assert_eq!(costs["packedStoreHighWater"], 6);
        assert_eq!(costs["aggregateFallbacks"], 0);
        assert_eq!(costs["aggregateRejections"], 0);
        assert_eq!(costs["looseLookupAttempts"], 30);
        assert!(
            costs["compressionUs"].as_u64().unwrap() > 0,
            "actual packed miss compression records elapsed work"
        );
        assert!(
            costs["looseLookupUs"].as_u64().unwrap() > 0,
            "actual ordered misses record elapsed work"
        );
        assert_eq!(costs["representationMisses"], 4);
        assert_eq!(costs["representationHits"], 26);
        assert_eq!(costs["savedReferenceAttempts"], 10);
        assert_eq!(costs["workspaceGitAttempts"], 0);
        for key in [
            "looseLookupUs",
            "representationUs",
            "compressionUs",
            "savedReferenceUs",
            "workspaceGitUs",
            "workspaceGitCommandUs",
        ] {
            assert!(costs[key].is_u64(), "completed export reports actual {key}");
        }
        assert!(
            costs["representationUs"].as_u64().unwrap() >= costs["compressionUs"].as_u64().unwrap()
        );
        assert!(
            costs["savedReferenceUs"].as_u64().unwrap()
                >= costs["representationUs"].as_u64().unwrap()
        );
        for key in [
            "freshInspectionUs",
            "nativeQueryUs",
            "nativeSpawnUs",
            "settlementUs",
        ] {
            assert!(
                costs[key].as_u64().unwrap() > 0,
                "actual {key} is measured through final settlement"
            );
        }
        assert!(costs
            .as_object()
            .unwrap()
            .values()
            .all(serde_json::Value::is_u64));
        assert!(
            events
                .iter()
                .filter(|event| event["phase"] == "saved_objects" && event["state"] == "progress")
                .count()
                <= 1,
            "reader costs preserve existing five-second progress throttling"
        );
    }

    #[test]
    fn saved_object_observer_reports_loose_and_optional_workspace_costs() {
        for outcome in [
            "success",
            "missing",
            "command_failure",
            "loose_refusal",
            "representation_refusal",
            "prelookup_refusal",
        ] {
            let fixture = reuse_fixture(false);
            let workspace = fixture.dir.path().join("workspace");
            let output = sanitized_git_command()
                .arg("-C")
                .arg(&workspace)
                .args(["init", "-q"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let git_dir = workspace.join(".git");
            if outcome == "success" {
                let blob = fixture_git(
                    &git_dir,
                    &["hash-object", "-w", "--stdin"],
                    Some(b"synthetic overlapping saved blob"),
                );
                assert_eq!(blob, fixture.blob);
                let subtree = fixture_git(
                    &git_dir,
                    &["mktree"],
                    Some(format!("100644 blob {blob}\tnested\n").as_bytes()),
                );
                for (name, expected) in ["first", "second"].into_iter().zip(&fixture.trees) {
                    let tree = fixture_git(
                        &git_dir,
                        &["mktree"],
                        Some(
                            format!("100644 blob {blob}\t{name}\n040000 tree {subtree}\tsubtree\n")
                                .as_bytes(),
                        ),
                    );
                    assert_eq!(&tree, expected);
                }
            } else if outcome == "command_failure" {
                fs::write(git_dir.join("config"), b"[invalid config").unwrap();
            } else if outcome == "loose_refusal" {
                let path = fixture_object_path(&fixture, &fixture.trees[0]);
                fs::remove_file(&path).unwrap();
                fs::create_dir(path).unwrap();
            } else if outcome == "representation_refusal" {
                let path = fixture_object_path(&fixture, &fixture.trees[0]);
                fs::remove_file(&path).unwrap();
                fs::write(path, b"invalid zlib").unwrap();
            }
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    closure_bound: (outcome == "prelookup_refusal").then_some(1),
                    ..Default::default()
                };
            });
            let events = Arc::new(std::sync::Mutex::new(Vec::new()));
            let observed = events.clone();
            let result = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")).with_progress_observer(
                    move |event| {
                        observed
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(event).unwrap());
                    },
                ),
            );
            let refused = outcome.ends_with("refusal");
            assert_eq!(result.is_err(), refused, "{outcome}");
            let events = events.lock().unwrap();
            let event = events
                .iter()
                .find(|event| {
                    event["phase"] == "saved_objects"
                        && event["state"] == if refused { "failed" } else { "completed" }
                })
                .unwrap();
            let costs = &event["readerCosts"];
            assert_eq!(
                costs["looseLookupAttempts"],
                if refused { 1 } else { 30 },
                "{outcome}"
            );
            assert_eq!(
                costs["savedReferenceAttempts"],
                if refused { 1 } else { 10 },
                "{outcome}"
            );
            assert_eq!(
                costs["representationMisses"],
                if outcome == "loose_refusal" || outcome == "prelookup_refusal" {
                    0
                } else if refused {
                    1
                } else {
                    4
                },
                "{outcome}"
            );
            assert_eq!(
                costs["representationHits"],
                if refused { 0 } else { 26 },
                "{outcome}"
            );
            assert_eq!(
                costs["workspaceGitAttempts"],
                if refused { 0 } else { 9 },
                "{outcome}"
            );
            assert_eq!(
                costs["workspaceGitSuccesses"],
                if outcome == "success" { 9 } else { 0 },
                "{outcome}"
            );
            assert_eq!(
                costs["workspaceGitRefusals"],
                if outcome == "missing" || outcome == "command_failure" {
                    9
                } else {
                    0
                },
                "{outcome}"
            );
            if outcome == "command_failure" {
                assert_eq!(
                    costs["workspaceGitCommandStarts"], 9,
                    "actual failing Git command attempts"
                );
            } else if !refused {
                assert!(costs["workspaceGitCommandStarts"].as_u64().unwrap() > 9);
            }
            assert!(costs["looseLookupUs"].as_u64().unwrap() > 0);
            assert!(costs["savedReferenceUs"].as_u64().unwrap() > 0);
            if outcome != "loose_refusal" && outcome != "prelookup_refusal" {
                assert!(costs["representationUs"].as_u64().unwrap() > 0);
            }
            if !refused {
                assert!(costs["workspaceGitUs"].as_u64().unwrap() > 0);
                assert!(costs["workspaceGitCommandUs"].as_u64().unwrap() > 0);
            }
            assert_eq!(costs["nativeQueries"], 0);
            assert_eq!(costs["freshInspections"], 0);
            assert_eq!(costs["compressionUs"], 0);
            assert!(costs
                .as_object()
                .unwrap()
                .values()
                .all(serde_json::Value::is_u64));
            for key in [
                "looseLookupUs",
                "representationUs",
                "savedReferenceUs",
                "workspaceGitUs",
                "workspaceGitCommandUs",
            ] {
                assert!(costs[key].is_u64(), "{outcome}: measured {key}");
            }
            assert!(
                costs["workspaceGitUs"].as_u64().unwrap()
                    >= costs["workspaceGitCommandUs"].as_u64().unwrap()
            );
            if let Ok(exported) = result {
                assert_eq!(exported.manifest().saved_snapshots.len(), 2);
                assert!(exported
                    .manifest()
                    .saved_snapshots
                    .iter()
                    .all(|reference| reference.objects.len() == 3));
                assert_eq!(
                    exported
                        .manifest()
                        .assets
                        .iter()
                        .filter(|asset| asset.kind == "git_tree_reference")
                        .count(),
                    if outcome == "success" { 2 } else { 0 }
                );
                let payload: serde_json::Value =
                    serde_json::from_slice(&fs::read(&exported.payload_path).unwrap()).unwrap();
                assert!(payload.to_string().contains(&fixture.trees[0]));
                assert!(payload.to_string().contains(&fixture.trees[1]));
            }
        }
    }

    #[test]
    fn workspace_git_command_cost_counts_failed_spawn_attempt() {
        let fixture = tempfile::tempdir().unwrap();
        let command = Command::new(fixture.path().join("missing-owned-git"));
        let mut costs = SourceReaderCosts::default();
        assert!(checked_git_output(command, &mut Some(&mut costs)).is_err());
        assert_eq!(costs.workspace_git_command_starts, 1);
        assert!(costs.workspace_git_command_us > 0);
        assert_eq!(
            costs.native_spawns, 0,
            "workspace attempts never relabel packed owners"
        );
    }

    #[test]
    fn workspace_metadata_census_reduces_actual_starts() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let git_dir = workspace.join(".git");
        fixture_git(&git_dir, &["init", "-q"], None);
        let mut entries = String::new();
        for index in 0..256 {
            let id = fixture_git(
                &git_dir,
                &["hash-object", "-w", "--stdin"],
                Some(format!("distinct fixture blob {index}").as_bytes()),
            );
            entries.push_str(&format!("100644 blob {id}\tfile{index}\n"));
        }
        let subtree = fixture_git(&git_dir, &["mktree"], Some(entries.as_bytes()));
        let tree = fixture_git(
            &git_dir,
            &["mktree"],
            Some(format!("040000 tree {subtree}\tnested\n").as_bytes()),
        );
        let mut costs = SourceReaderCosts::default();
        let inspection = inspect_git_tree_with_costs(&workspace, &tree, Some(&mut costs)).unwrap();
        assert!(inspection.closure_bytes > 6000);
        eprintln!(
            "workspace census actual starts={} T=2 U=258",
            costs.workspace_git_command_starts
        );
        assert_eq!(
            costs.workspace_git_command_starts,
            if cfg!(unix) { 20 } else { 4 + 2 * 2 + 258 },
            "the complete qualified census must remove measured launches"
        );
        assert_eq!(costs.native_spawns, 0);
    }

    #[cfg(unix)]
    fn workspace_many_tree_fixture(format: &str, count: usize) -> (TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let git_dir = workspace.join(".git");
        fixture_git(
            &git_dir,
            &["init", "-q", &format!("--object-format={format}")],
            None,
        );
        let a = fixture_git(
            &git_dir,
            &["hash-object", "-w", "--stdin"],
            Some(b"fixed leaf a"),
        );
        let b = fixture_git(
            &git_dir,
            &["hash-object", "-w", "--stdin"],
            Some(b"fixed leaf b"),
        );
        let mut tree = fixture_git(
            &git_dir,
            &["mktree"],
            Some(format!("100644 blob {a}\ta\n120000 blob {b}\tb\n").as_bytes()),
        );
        let first = tree.clone();
        for i in 1..count {
            tree = fixture_git(&git_dir, &["mktree"], Some(format!("040000 tree {tree}\tchain{i}\n040000 tree {first}\trepeated\n100755 blob {a}\tleaf\n").as_bytes()));
        }
        (dir, workspace, tree.to_ascii_uppercase())
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_reduces_many_tree_actual_starts() {
        let mut measured = Vec::new();
        for format in ["sha1", "sha256"] {
            for count in [8, 64] {
                let (_dir, workspace, tree) = workspace_many_tree_fixture(format, count);
                workspace_metadata_test_hooks::STATE
                    .with(|state| *state.borrow_mut() = Default::default());
                let mut costs = SourceReaderCosts::default();
                let inspected =
                    inspect_git_tree_with_costs(&workspace, &tree, Some(&mut costs)).unwrap();
                let records = workspace_metadata_test_hooks::STATE
                    .with(|state| state.borrow().records.clone());
                assert_eq!(records.len(), count + 2);
                assert!(records.iter().any(|record| record.0 == tree));
                assert_eq!(
                    inspected.closure_sha256,
                    digest(&serde_json::to_vec(&records).unwrap())
                );
                eprintln!(
                    "many tree {format} T={count} U={} actual starts={}",
                    records.len(),
                    costs.workspace_git_command_starts
                );
                measured.push(costs.workspace_git_command_starts);
            }
        }
        assert_eq!(
            measured,
            [20, 20, 20, 20],
            "one guarded native tree owner removes the per-tree launch slope"
        );
    }

    fn copy_fixture_objects(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let destination = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_fixture_objects(&entry.path(), &destination);
            } else {
                fs::copy(entry.path(), destination).unwrap();
            }
        }
    }

    fn workspace_metadata_fixture(
        format: &str,
        packed: bool,
        alternates: bool,
    ) -> (TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace with spaces");
        fs::create_dir(&workspace).unwrap();
        let git_dir = workspace.join(".git");
        fixture_git(
            &git_dir,
            &["init", "-q", &format!("--object-format={format}")],
            None,
        );
        let mut entries = String::new();
        let mut shared = String::new();
        for index in 0..32 {
            let id = fixture_git(
                &git_dir,
                &["hash-object", "-w", "--stdin"],
                Some(format!("current metadata object {index}").as_bytes()),
            );
            if index == 0 {
                shared = id.clone();
            }
            entries.push_str(&format!("100644 blob {id}\tfile{index}\n"));
        }
        entries.push_str(&format!(
            "100755 blob {shared}\texecutable\n120000 blob {shared}\tsymlink\n"
        ));
        let nested = fixture_git(&git_dir, &["mktree"], Some(entries.as_bytes()));
        let tree = fixture_git(
            &git_dir,
            &["mktree"],
            Some(
                format!("040000 tree {nested}\tnested\n100644 blob {shared}\tshared\n").as_bytes(),
            ),
        );
        fixture_git(&git_dir, &["update-ref", "refs/fixture/root", &tree], None);
        if packed {
            fixture_git(&git_dir, &["repack", "-a", "-d"], None);
            fixture_git(&git_dir, &["prune-packed"], None);
        }
        if alternates {
            let mut stores = Vec::new();
            for name in ["first alternate.git", "second alternate.git"] {
                let alternate = workspace.join(name);
                fixture_git(
                    &alternate,
                    &["init", "--bare", "-q", &format!("--object-format={format}")],
                    None,
                );
                copy_fixture_objects(&git_dir.join("objects"), &alternate.join("objects"));
                stores.push(alternate.join("objects"));
            }
            fs::write(
                git_dir.join("objects/info/alternates"),
                format!("{}\n{}\n", stores[0].display(), stores[1].display()),
            )
            .unwrap();
        }
        (dir, workspace, tree)
    }

    #[test]
    fn workspace_metadata_preserves_full_records_formats_and_ordered_stores() {
        for format in ["sha1", "sha256"] {
            for packed in [false, true] {
                let (_dir, workspace, tree) = workspace_metadata_fixture(format, packed, true);
                let tree = tree.to_ascii_uppercase();
                let mut outputs = Vec::new();
                let mut measurements = Vec::new();
                for mode in ["legacy", "census", "fusion"] {
                    workspace_metadata_test_hooks::STATE.with(|state| {
                        *state.borrow_mut() = workspace_metadata_test_hooks::State {
                            legacy: mode == "legacy",
                            fusion: mode == "fusion",
                            ..Default::default()
                        }
                    });
                    let mut costs = SourceReaderCosts::default();
                    let inspection =
                        inspect_git_tree_with_costs(&workspace, &tree, Some(&mut costs)).unwrap();
                    let records = workspace_metadata_test_hooks::STATE
                        .with(|state| state.borrow().records.clone());
                    assert_eq!(records.len(), 34);
                    assert!(records.iter().any(|record| record.0 == tree));
                    let bytes = serde_json::to_vec(&records).unwrap();
                    assert_eq!(inspection.closure_sha256, digest(&bytes));
                    outputs.push((
                        inspection.identity,
                        inspection.closure_bytes,
                        inspection.closure_sha256,
                        records,
                        bytes,
                    ));
                    measurements.push(costs.workspace_git_command_starts);
                }
                assert_eq!(outputs[0], outputs[1]);
                assert_eq!(outputs[0], outputs[2]);
                assert_eq!(measurements[0], 4 + 2 * 2 + 2 * 34);
                assert_eq!(
                    measurements[1],
                    if cfg!(unix) { 20 } else { 4 + 2 * 2 + 34 }
                );
                assert_eq!(measurements[2], 4 + 2 * 2 + 34);
                eprintln!("complete workspace tuples {format}/packed={packed}: legacy/census/fusion starts {measurements:?}");
            }
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[test]
    fn workspace_metadata_preserves_entire_native_exports() {
        for packed in [false, true] {
            let fixture = reuse_fixture(packed);
            let workspace = fixture.dir.path().join("workspace");
            let git_dir = workspace.join(".git");
            fixture_git(&git_dir, &["init", "-q"], None);
            copy_fixture_objects(&fixture.store, &git_dir.join("objects"));
            let mut outputs = Vec::new();
            for mode in ["legacy", "census", "fusion"] {
                workspace_metadata_test_hooks::STATE.with(|state| {
                    *state.borrow_mut() = workspace_metadata_test_hooks::State {
                        legacy: mode == "legacy",
                        fusion: mode == "fusion",
                        ..Default::default()
                    }
                });
                let exported = export_exact_session(
                    &fixture.inventory,
                    "ses_exact",
                    ExportOptions::new(fixture.dir.path().join("extract")),
                )
                .unwrap();
                assert_eq!(
                    exported
                        .manifest()
                        .assets
                        .iter()
                        .filter(|asset| asset.kind == "git_tree_reference")
                        .count(),
                    2
                );
                outputs.push((
                    fs::read(&exported.payload_path).unwrap(),
                    serde_json::to_value(exported.manifest()).unwrap(),
                    source_graph_fingerprint(exported.manifest()).unwrap(),
                ));
            }
            assert_eq!(outputs[0], outputs[1]);
            assert_eq!(outputs[0], outputs[2]);
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_preserves_many_tree_records_and_native_domain() {
        for format in ["sha1", "sha256"] {
            for count in [8, 64] {
                for packed in [false, true] {
                    let (_dir, workspace, tree) = workspace_many_tree_fixture(format, count);
                    let git = workspace.join(".git");
                    fixture_git(&git, &["update-ref", "refs/fixture/root", &tree], None);
                    if packed {
                        fixture_git(&git, &["repack", "-a", "-d"], None);
                        fixture_git(&git, &["prune-packed"], None);
                    }
                    let alternate = workspace.join("alternate.git");
                    fixture_git(
                        &alternate,
                        &["init", "--bare", "-q", &format!("--object-format={format}")],
                        None,
                    );
                    copy_fixture_objects(&git.join("objects"), &alternate.join("objects"));
                    fs::write(
                        git.join("objects/info/alternates"),
                        format!("{0}\n{0}\n", alternate.join("objects").display()),
                    )
                    .unwrap();
                    let mut outputs = Vec::new();
                    let mut starts = Vec::new();
                    for mode in ["old_tree", "new_tree", "fusion"] {
                        workspace_metadata_test_hooks::STATE.with(|state| {
                            *state.borrow_mut() = workspace_metadata_test_hooks::State {
                                old_trees: mode == "old_tree",
                                fusion: mode == "fusion",
                                ..Default::default()
                            }
                        });
                        let mut costs = SourceReaderCosts::default();
                        let inspected =
                            inspect_git_tree_with_costs(&workspace, &tree, Some(&mut costs))
                                .unwrap();
                        let records = workspace_metadata_test_hooks::STATE
                            .with(|state| state.borrow().records.clone());
                        let bytes = serde_json::to_vec(&records).unwrap();
                        outputs.push((
                            inspected.identity,
                            inspected.closure_bytes,
                            inspected.closure_sha256,
                            records,
                            bytes,
                        ));
                        starts.push(costs.workspace_git_command_starts);
                    }
                    assert_eq!(outputs[0], outputs[1]);
                    assert_eq!(outputs[0], outputs[2]);
                    assert_eq!(
                        starts,
                        [
                            19 + 2 * count as u64,
                            20,
                            4 + 2 * count as u64 + count as u64 + 2
                        ]
                    );
                    eprintln!("many-tree complete tuple equality {format} T{count} packed={packed} starts={starts:?}");
                }
            }
            let (_dir, workspace, _) = workspace_many_tree_fixture(format, 8);
            let git = workspace.join(".git");
            let blob = fixture_git(
                &git,
                &["hash-object", "-w", "--stdin"],
                Some(b"native mode leaf"),
            );
            let empty = fixture_git(&git, &["mktree"], Some(b""));
            for mode in [
                "40000",
                "040000",
                "0040000",
                "40777",
                "100644",
                "100600",
                "100664",
                "100755",
                "120000",
                "120777",
                "100000",
                "000000100644",
                "777777777777777777777777777777777777777777100644",
                "160000",
                "000000",
                "20000",
                "140000",
                "170000",
                "777777",
                "1008",
                "",
            ] {
                let is_tree = ["40000", "040000", "0040000", "40777"].contains(&mode);
                for name in [b"opaque\xff\t\n\\/name".as_slice(), b"", &vec![b'n'; 70000]] {
                    let mut body = format!("{mode} ").into_bytes();
                    body.extend(name);
                    body.push(0);
                    body.extend(hex::decode(if is_tree { &empty } else { &blob }).unwrap());
                    let tree = fixture_git(
                        &git,
                        &["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
                        Some(&body),
                    );
                    let mut outputs = Vec::new();
                    for old_trees in [true, false] {
                        workspace_metadata_test_hooks::STATE.with(|state| {
                            *state.borrow_mut() = workspace_metadata_test_hooks::State {
                                old_trees,
                                ..Default::default()
                            }
                        });
                        let result = inspect_git_tree(&workspace, &tree);
                        let records = workspace_metadata_test_hooks::STATE
                            .with(|state| state.borrow().records.clone());
                        outputs.push(
                            result
                                .map(|value| {
                                    (
                                        value.identity,
                                        value.closure_bytes,
                                        value.closure_sha256,
                                        records,
                                    )
                                })
                                .ok(),
                        );
                    }
                    assert_eq!(
                        outputs[0],
                        outputs[1],
                        "native mode {format}/{mode}, name length {}",
                        name.len()
                    );
                }
            }
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_preserves_native_packed_resolution_over_unused_loose_copy() {
        for format in ["sha1", "sha256"] {
            let (_dir, workspace, tree) = workspace_many_tree_fixture(format, 8);
            let git = workspace.join(".git");
            fixture_git(&git, &["update-ref", "refs/fixture/root", &tree], None);
            fixture_git(&git, &["repack", "-a", "-d"], None);
            fixture_git(&git, &["prune-packed"], None);
            let child = fixture_git(&git, &["ls-tree", &tree], None)
                .lines()
                .rfind(|line| line.contains(" tree "))
                .unwrap()
                .split_whitespace()
                .nth(2)
                .unwrap()
                .to_string();
            let loose = git.join("objects").join(&child[..2]).join(&child[2..]);
            fs::create_dir_all(loose.parent().unwrap()).unwrap();
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(b"tree 0\0").unwrap();
            let wrong = encoder.finish().unwrap();
            let mut outputs = Vec::new();
            for old_trees in [true, false] {
                if old_trees {
                    fs::write(&loose, &wrong).unwrap();
                } else {
                    fs::remove_file(&loose).unwrap();
                }
                let added = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let observed = added.clone();
                let path = loose.clone();
                let bytes = wrong.clone();
                workspace_metadata_test_hooks::STATE.with(|state| {
                    *state.borrow_mut() = workspace_metadata_test_hooks::State {
                        old_trees,
                        barrier: Some(Box::new(move |at, _| {
                            if at == "tree_after"
                                && !observed.swap(true, std::sync::atomic::Ordering::SeqCst)
                            {
                                fs::write(&path, &bytes).unwrap();
                            }
                        })),
                        ..Default::default()
                    }
                });
                let inspection = inspect_git_tree(&workspace, &tree).unwrap();
                if !old_trees {
                    assert!(added.load(std::sync::atomic::Ordering::SeqCst));
                }
                let records = workspace_metadata_test_hooks::STATE
                    .with(|state| state.borrow().records.clone());
                assert_eq!(records.len(), 10);
                outputs.push((
                    inspection.identity,
                    inspection.closure_bytes,
                    inspection.closure_sha256,
                    records,
                ));
            }
            assert_eq!(outputs[0],outputs[1],"Git chooses its current packed body; unused duplicate bodies are not separately certified");
            let root = git
                .join("objects")
                .join(tree[..2].to_ascii_lowercase())
                .join(tree[2..].to_ascii_lowercase());
            fs::create_dir_all(root.parent().unwrap()).unwrap();
            fs::write(&root, &wrong).unwrap();
            // A loose-only wrong body must fail its actual returned identity.
            for entry in fs::read_dir(git.join("objects/pack")).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
            workspace_metadata_test_hooks::STATE
                .with(|state| *state.borrow_mut() = Default::default());
            assert!(inspect_git_tree(&workspace, &tree).is_err());
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_preserves_many_tree_entire_native_export() {
        let fixture = reuse_fixture(false);
        let (_many, workspace, tree) = workspace_many_tree_fixture("sha1", 64);
        copy_fixture_objects(&workspace.join(".git/objects"), &fixture.store);
        let target_workspace = fixture.dir.path().join("workspace");
        fixture_git(&target_workspace.join(".git"), &["init", "-q"], None);
        copy_fixture_objects(
            &workspace.join(".git/objects"),
            &target_workspace.join(".git/objects"),
        );
        let db = Connection::open(fixture.dir.path().join("data/opencode.db")).unwrap();
        // Update every retained reference through ordinary SQL fixture setup.
        for old in &fixture.trees {
            for (table, column) in [
                ("session", "revert"),
                ("part", "data"),
                ("session_input", "prompt"),
                ("session_context_epoch", "snapshot"),
                ("event", "data"),
            ] {
                db.execute(
                    &format!("UPDATE {table} SET {column}=replace({column},?1,?2)"),
                    rusqlite::params![old, tree.to_ascii_lowercase()],
                )
                .unwrap();
            }
        }
        drop(db);
        let mut outputs = Vec::new();
        for mode in ["old_tree", "new_tree", "fusion"] {
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    old_trees: mode == "old_tree",
                    fusion: mode == "fusion",
                    ..Default::default()
                }
            });
            let bundle = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("many-extract")),
            )
            .unwrap();
            assert!(bundle
                .manifest()
                .assets
                .iter()
                .any(|asset| asset.kind == "git_tree_reference"));
            assert!(bundle
                .manifest()
                .saved_snapshots
                .iter()
                .all(|saved| saved.objects.len() == 66));
            outputs.push((
                fs::read(&bundle.payload_path).unwrap(),
                serde_json::to_vec(bundle.manifest()).unwrap(),
                source_graph_fingerprint(bundle.manifest()).unwrap(),
            ));
        }
        assert_eq!(outputs[0], outputs[1]);
        assert_eq!(outputs[0], outputs[2]);
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    fn named_user_fixture_include(include: &Path) -> String {
        use std::os::unix::ffi::OsStrExt;

        // Git expands ~name from the account record, independently of USER/HOME.
        let uid = unsafe { libc::geteuid() };
        let mut account: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buffer = vec![0u8; 16 * 1024];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut account,
                buffer.as_mut_ptr().cast::<libc::c_char>(),
                buffer.len(),
                &mut result,
            )
        };
        assert_eq!(status, 0, "getpwuid_r must succeed for the effective uid");
        assert!(!result.is_null(), "effective uid must have a passwd entry");
        let user = unsafe { std::ffi::CStr::from_ptr(account.pw_name) }
            .to_str()
            .unwrap()
            .to_owned();
        let home = unsafe { std::ffi::CStr::from_ptr(account.pw_dir) };
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes()));
        assert!(home.is_absolute());
        let depth = home
            .components()
            .filter(|part| matches!(part, std::path::Component::Normal(_)))
            .count();
        format!(
            "~{user}/{}{}",
            "../".repeat(depth),
            include.strip_prefix("/").unwrap().display()
        )
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_named_user_include_preselects_fresh_fusion() {
        let fixture = reuse_fixture(true);
        let workspace = fixture.dir.path().join("workspace");
        let git_dir = workspace.join(".git");
        fixture_git(&git_dir, &["init", "-q"], None);
        copy_fixture_objects(&fixture.store, &git_dir.join("objects"));
        let include = fixture.dir.path().join("named-user include");
        fs::write(&include, "[core]\nignorecase = true\n").unwrap();
        let named_path = named_user_fixture_include(&include);
        fixture_git(&git_dir, &["config", "include.path", &named_path], None);
        assert_eq!(
            fixture_git(
                &git_dir,
                &["config", "--bool", "--get", "core.ignorecase"],
                None
            ),
            "true",
            "real Git must resolve the valid named-user include"
        );
        let mut inspections = Vec::new();
        let mut exports = Vec::new();
        for legacy in [true, false] {
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    legacy,
                    ..Default::default()
                }
            });
            let tree = fixture.trees[0].to_ascii_uppercase();
            let mut costs = SourceReaderCosts::default();
            let inspection =
                inspect_git_tree_with_costs(&workspace, &tree, Some(&mut costs)).unwrap();
            let (records, counts) = workspace_metadata_test_hooks::STATE.with(|state| {
                (
                    state.borrow().records.clone(),
                    state.borrow().counts.clone(),
                )
            });
            inspections.push((
                inspection.identity,
                inspection.closure_bytes,
                inspection.closure_sha256,
                serde_json::to_vec(&records).unwrap(),
                records.clone(),
            ));
            assert_eq!(counts.get("census_start").copied().unwrap_or(0), 0);
            if !legacy {
                assert_eq!(counts.get("fusion_start"), Some(&records.len()));
                assert_eq!(
                    costs.workspace_git_command_starts,
                    4 + 1 + 2 * 2 + records.len() as u64
                );
            }
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    legacy,
                    ..Default::default()
                }
            });
            let exported = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            )
            .unwrap();
            assert_eq!(
                exported
                    .manifest()
                    .assets
                    .iter()
                    .filter(|asset| asset.kind == "git_tree_reference")
                    .count(),
                2
            );
            let counts =
                workspace_metadata_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(counts.get("census_start").copied().unwrap_or(0), 0);
            if !legacy {
                assert!(counts["fusion_start"] > 0);
            }
            exports.push((
                fs::read(&exported.payload_path).unwrap(),
                serde_json::to_value(exported.manifest()).unwrap(),
                source_graph_fingerprint(exported.manifest()).unwrap(),
            ));
        }
        assert_eq!(inspections[0], inspections[1]);
        assert_eq!(exports[0], exports[1]);
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        fs::write(&include, "[broken native configuration\n").unwrap();
        assert!(inspect_git_tree(&workspace, &fixture.trees[0]).is_err());
        workspace_metadata_test_hooks::STATE.with(|state| {
            let state = state.borrow();
            assert_eq!(state.counts.get("census_start").copied().unwrap_or(0), 0);
            assert_eq!(state.counts.get("fusion_start").copied().unwrap_or(0), 0);
        });
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_refuses_current_storage_and_context_mutations() {
        for phase in [
            "qualified",
            "traversed",
            "precensus",
            "before_query",
            "after_query",
            "last_response",
            "settled",
        ] {
            for mutation in [
                "pack_remove",
                "index_remove",
                "pack_replace",
                "pack_add",
                "pack_entry_remove",
                "alternate_order",
                "alternate_remove",
                "alternate_add",
                "loose_add",
                "loose_remove",
                "loose_redirect",
                "config",
                "include",
                "include_absent",
                "include_same_values",
                "include_absent_empty",
                "include_named_user",
                "worktree_config",
                "format",
                "git_marker",
                "common_dir",
            ] {
                let (dir, workspace, tree) =
                    workspace_metadata_fixture("sha1", true, mutation.starts_with("alternate"));
                let git_dir = workspace.join(".git");
                let include = dir.path().join("included config with spaces");
                if mutation.starts_with("include") {
                    fixture_git(
                        &git_dir,
                        &["config", "include.path", include.to_str().unwrap()],
                        None,
                    );
                    if mutation == "include" || mutation == "include_same_values" {
                        fs::write(&include, "[core]\nignorecase = false\n").unwrap();
                    }
                }
                if mutation == "worktree_config" {
                    fixture_git(
                        &git_dir,
                        &["config", "extensions.worktreeConfig", "true"],
                        None,
                    );
                    fs::write(
                        git_dir.join("config.worktree"),
                        "[core]\nignorecase = false\n",
                    )
                    .unwrap();
                }
                if mutation == "pack_entry_remove" {
                    fs::write(git_dir.join("objects/pack/fixture.keep"), b"owned fixture").unwrap();
                }
                let blob = fixture_git(&git_dir, &["ls-tree", "-r", &tree], None)
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(2)
                    .unwrap()
                    .to_string();
                let loose_path = git_dir.join("objects").join(&blob[..2]).join(&blob[2..]);
                // Keep the fanout present before observation, so introducing a
                // selected symlink cannot hide behind an object-store stamp change.
                if matches!(mutation, "loose_add" | "loose_redirect") {
                    fs::create_dir_all(loose_path.parent().unwrap()).unwrap();
                }
                let loose_bytes = {
                    let body = fixture_git(&git_dir, &["cat-file", "blob", &blob], None);
                    let mut encoder =
                        flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                    write!(encoder, "blob {}\0{body}", body.len()).unwrap();
                    encoder.finish().unwrap()
                };
                if mutation == "loose_remove" {
                    fs::create_dir_all(loose_path.parent().unwrap()).unwrap();
                    fs::write(&loose_path, &loose_bytes).unwrap();
                }
                let original_config = fixture_git(
                    &git_dir,
                    &["config", "--list", "--show-origin", "--includes"],
                    None,
                );
                let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let executed = observed.clone();
                let owned_workspace = workspace.clone();
                let owned_git = git_dir.clone();
                let owned_tree = tree.clone();
                let parked = dir.path().join("parked-owned-entry");
                workspace_metadata_test_hooks::STATE.with(|state| {
                    *state.borrow_mut() = workspace_metadata_test_hooks::State {
                        barrier: Some(Box::new(move |at, _object| {
                            if at != phase
                                || executed.swap(true, std::sync::atomic::Ordering::SeqCst)
                            {
                                return;
                            }
                            match mutation {
                                "pack_remove" | "index_remove" | "pack_replace" => {
                                    let extension = if mutation == "index_remove" {
                                        "idx"
                                    } else {
                                        "pack"
                                    };
                                    let selected = fs::read_dir(owned_git.join("objects/pack"))
                                        .unwrap()
                                        .map(|entry| entry.unwrap().path())
                                        .find(|path| {
                                            path.extension().is_some_and(|value| value == extension)
                                        })
                                        .unwrap();
                                    fs::rename(&selected, &parked).unwrap();
                                    if mutation == "pack_replace" {
                                        fs::write(&selected, b"invalid current replacement")
                                            .unwrap();
                                    }
                                    let mut command = workspace_git_command(
                                        &GitRepository {
                                            work_tree: owned_workspace.clone(),
                                            git_dir: owned_git.clone(),
                                        },
                                        &["cat-file", "-t", &owned_tree],
                                    );
                                    assert!(
                                        !command.output().unwrap().status.success(),
                                        "fresh native reference must observe selected storage loss"
                                    );
                                }
                                "pack_add" => {
                                    fs::write(
                                        owned_git.join("objects/pack/new-entry.keep"),
                                        b"owned new entry",
                                    )
                                    .unwrap();
                                }
                                "pack_entry_remove" => {
                                    fs::remove_file(owned_git.join("objects/pack/fixture.keep"))
                                        .unwrap();
                                }
                                "alternate_order" => {
                                    let file = owned_git.join("objects/info/alternates");
                                    let original = fs::read_to_string(&file).unwrap();
                                    let mut lines = original.lines().collect::<Vec<_>>();
                                    lines.reverse();
                                    fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
                                    assert_ne!(
                                        read_alternates_file(&file).unwrap().unwrap(),
                                        original
                                    );
                                }
                                "alternate_remove" => {
                                    fs::rename(
                                        owned_workspace.join("first alternate.git/objects"),
                                        &parked,
                                    )
                                    .unwrap();
                                }
                                "alternate_add" => {
                                    let file = owned_git.join("objects/info/alternates");
                                    let mut contents = fs::read_to_string(&file).unwrap();
                                    contents.push_str(&format!(
                                        "{}\n",
                                        owned_workspace.join("new alternate.git/objects").display()
                                    ));
                                    fs::write(file, contents).unwrap();
                                }
                                "loose_add" => {
                                    fs::create_dir_all(loose_path.parent().unwrap()).unwrap();
                                    fs::write(&loose_path, &loose_bytes).unwrap();
                                }
                                "loose_remove" => {
                                    fs::remove_file(&loose_path).unwrap();
                                }
                                "loose_redirect" => {
                                    fs::create_dir_all(loose_path.parent().unwrap()).unwrap();
                                    fs::write(&parked, &loose_bytes).unwrap();
                                    std::os::unix::fs::symlink(&parked, &loose_path).unwrap();
                                    assert!(verify_git_loose_object_paths(
                                        &owned_workspace,
                                        &[owned_git.join("objects")],
                                        std::slice::from_ref(&blob)
                                    )
                                    .is_err());
                                }
                                "config" => {
                                    fixture_git(
                                        &owned_git,
                                        &["config", "core.ignorecase", "true"],
                                        None,
                                    );
                                }
                                "include" | "include_absent" => {
                                    fs::write(&include, "[core]\nignorecase = true\n").unwrap();
                                }
                                "include_same_values" => {
                                    fs::write(&include, "# changed current dependency\n[core]\nignorecase = false\n").unwrap();
                                }
                                "include_absent_empty" => {
                                    fs::write(&include, "# newly present native include dependency\n").unwrap();
                                }
                                "include_named_user" => {
                                    fs::write(&include, "[core]\nignorecase = true\n").unwrap();
                                    fixture_git(&owned_git, &["config", "include.path", &named_user_fixture_include(&include)], None);
                                }
                                "worktree_config" => {
                                    fs::write(
                                        owned_git.join("config.worktree"),
                                        "[core]\nignorecase = true\n",
                                    )
                                    .unwrap();
                                }
                                "format" => {
                                    let mut config =
                                        fs::read_to_string(owned_git.join("config")).unwrap();
                                    config.push_str("\n[extensions]\nobjectFormat = sha256\n");
                                    fs::write(
                                        owned_git.join("config"),
                                        config.replace(
                                            "repositoryformatversion = 0",
                                            "repositoryformatversion = 1",
                                        ),
                                    )
                                    .unwrap();
                                }
                                "git_marker" => {
                                    let target = owned_workspace.join("redirected.git");
                                    fs::rename(&owned_git, &target).unwrap();
                                    fs::write(
                                        &owned_git,
                                        format!("gitdir: {}\n", target.display()),
                                    )
                                    .unwrap();
                                }
                                "common_dir" => {
                                    fs::write(
                                        owned_git.join("commondir"),
                                        "missing-current-common-dir\n",
                                    )
                                    .unwrap();
                                }
                                _ => unreachable!(),
                            }
                            if matches!(
                                mutation,
                                "config" | "include" | "include_absent" | "worktree_config"
                            ) {
                                assert_ne!(
                                    fixture_git(
                                        &owned_git,
                                        &["config", "--list", "--show-origin", "--includes"],
                                        None
                                    ),
                                    original_config,
                                    "fresh native effective configuration changed"
                                );
                            }
                        })),
                        ..Default::default()
                    }
                });
                let result = inspect_git_tree(&workspace, &tree);
                if let Ok(current) = &result {
                    assert!(
                        matches!(phase, "qualified" | "traversed")
                            && matches!(mutation, "loose_remove" | "loose_add"),
                        "{phase}/{mutation}: no stale workspace commitment may survive mutation"
                    );
                    // A duplicate removed before the selected census is observed
                    // may succeed only with entirely current native metadata.
                    workspace_metadata_test_hooks::STATE.with(|state| {
                        let mut state = state.borrow_mut();
                        state.barrier = None;
                        state.legacy = true;
                    });
                    let reference = inspect_git_tree(&workspace, &tree).unwrap();
                    assert_eq!(
                        (
                            &current.identity,
                            current.closure_bytes,
                            &current.closure_sha256
                        ),
                        (
                            &reference.identity,
                            reference.closure_bytes,
                            &reference.closure_sha256
                        )
                    );
                }
                assert!(
                    observed.load(std::sync::atomic::Ordering::SeqCst),
                    "{phase}/{mutation}: mutation barrier executed"
                );
                workspace_metadata_test_hooks::STATE.with(|state| {
                    let state = state.borrow();
                    assert_eq!(state.records.is_empty(), result.is_err());
                    assert_eq!(state.counts.get("spawn"), state.counts.get("reap"));
                    assert_eq!(
                        state.counts.get("drain_spawn"),
                        state.counts.get("drain_join")
                    );
                });
            }
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_fresh_guards_before_each_native_read() {
        for (phase, mutation) in [
            ("tree_before", "selected"),
            ("tree_before", "duplicate_selected"),
            ("descendant", "selected"),
            ("descendant", "fanout"),
            ("tree_after", "config"),
            ("last_after", "config"),
            ("descendant", "config"),
            ("tree_before", "pack_entry"),
            ("descendant", "pack_remove"),
            ("descendant", "index_replace"),
            ("descendant", "alternate_order"),
            ("descendant", "alternate_nested"),
            ("descendant", "alternate_outside"),
            ("descendant", "include"),
            ("descendant", "include_absent"),
            ("descendant", "named_user"),
            ("descendant", "commondir"),
            ("descendant", "worktree_config"),
            ("descendant", "git_marker"),
            ("descendant", "format"),
            ("tree_close", "selected"),
            ("tree_settled", "selected"),
        ] {
            let (dir, workspace, root) = workspace_many_tree_fixture("sha1", 8);
            let git = workspace.join(".git");
            fixture_git(&git, &["update-ref", "refs/fixture/root", &root], None);
            fixture_git(&git, &["repack", "-a", "-d"], None);
            fixture_git(&git, &["prune-packed"], None);
            let selected = if phase == "descendant" {
                fixture_git(&git, &["ls-tree", &root], None)
                    .lines()
                    .rfind(|line| line.contains(" tree "))
                    .unwrap()
                    .split_whitespace()
                    .nth(2)
                    .unwrap()
                    .to_string()
            } else {
                root.to_ascii_lowercase()
            };
            let alternate = workspace.join("alternate.git");
            fixture_git(&alternate, &["init", "--bare", "-q"], None);
            copy_fixture_objects(&git.join("objects"), &alternate.join("objects"));
            let alternate_store = alternate.join("objects");
            fs::write(
                git.join("objects/info/alternates"),
                format!("{0}\n{0}\n", alternate_store.display()),
            )
            .unwrap();
            let leaf = if mutation == "duplicate_selected" {
                alternate_store.join(&selected[..2]).join(&selected[2..])
            } else {
                git.join("objects")
                    .join(&selected[..2])
                    .join(&selected[2..])
            };
            fs::create_dir_all(leaf.parent().unwrap()).unwrap();
            let parked = dir.path().join("parked");
            fs::write(&parked, b"unqualified fixture").unwrap();
            let include = git.join("fixture-include");
            if mutation == "include" {
                fs::write(&include, "[core]\nignorecase=false\n").unwrap();
            }
            if mutation.starts_with("include") {
                fixture_git(&git, &["config", "include.path", "fixture-include"], None);
            }
            let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let changed = fired.clone();
            let mut first = true;
            let mut responses = 0;
            let owned_workspace = workspace.clone();
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    barrier: Some(Box::new(move |at, object| {
                        let target = if phase == "last_after" {
                            if at != "tree_after" {
                                return;
                            }
                            responses += 1;
                            if responses != 8 {
                                return;
                            }
                            "tree_after"
                        } else if phase == "descendant" {
                            if at != "tree_before" {
                                return;
                            }
                            if first {
                                first = false;
                                return;
                            }
                            "tree_before"
                        } else {
                            phase
                        };
                        if at != target || changed.load(std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }
                        if phase == "descendant" {
                            assert!(object.eq_ignore_ascii_case(&selected));
                        }
                        changed.store(true, std::sync::atomic::Ordering::SeqCst);
                        match mutation {
                            "selected" | "duplicate_selected" => {
                                std::os::unix::fs::symlink(&parked, &leaf).unwrap()
                            }
                            "fanout" => {
                                fs::remove_dir(leaf.parent().unwrap()).unwrap();
                                std::os::unix::fs::symlink(dir.path(), leaf.parent().unwrap())
                                    .unwrap();
                            }
                            "config" => {
                                let mut f = OpenOptions::new()
                                    .append(true)
                                    .open(git.join("config"))
                                    .unwrap();
                                writeln!(f, "# changed bytes, same effective config").unwrap();
                            }
                            "pack_entry" => {
                                fs::write(git.join("objects/pack/new.keep"), b"new").unwrap()
                            }
                            "pack_remove" | "index_replace" => {
                                let extension = if mutation == "pack_remove" {
                                    "pack"
                                } else {
                                    "idx"
                                };
                                let path = fs::read_dir(git.join("objects/pack"))
                                    .unwrap()
                                    .map(|e| e.unwrap().path())
                                    .find(|p| p.extension().is_some_and(|e| e == extension))
                                    .unwrap();
                                if mutation == "pack_remove" {
                                    fs::remove_file(path).unwrap();
                                } else {
                                    let bytes = fs::read(&path).unwrap();
                                    fs::remove_file(&path).unwrap();
                                    fs::write(path, bytes).unwrap();
                                }
                            }
                            "alternate_order" => fs::write(
                                git.join("objects/info/alternates"),
                                format!("{}\n", alternate_store.display()),
                            )
                            .unwrap(),
                            "alternate_nested" => {
                                fs::write(alternate_store.join("info/alternates"), "missing\n")
                                    .unwrap()
                            }
                            "alternate_outside" => fs::write(
                                git.join("objects/info/alternates"),
                                format!("{}\n", dir.path().display()),
                            )
                            .unwrap(),
                            "include" | "include_absent" => {
                                fs::write(&include, "[core]\nignorecase=false\n# changed\n")
                                    .unwrap()
                            }
                            "named_user" => {
                                let mut f = OpenOptions::new()
                                    .append(true)
                                    .open(git.join("config"))
                                    .unwrap();
                                writeln!(f, "[include]\npath=~nonexistent-fixture/config").unwrap();
                            }
                            "commondir" => fs::write(git.join("commondir"), ".\n").unwrap(),
                            "worktree_config" => {
                                fs::write(git.join("config.worktree"), "[core]\nignorecase=false\n")
                                    .unwrap()
                            }
                            "git_marker" => {
                                fs::rename(&git, owned_workspace.join("parked.git")).unwrap();
                                fs::write(&git, "gitdir: parked.git\n").unwrap();
                            }
                            "format" => {
                                let mut f = OpenOptions::new()
                                    .append(true)
                                    .open(git.join("config"))
                                    .unwrap();
                                writeln!(f, "[extensions]\nobjectFormat=sha256").unwrap();
                            }
                            _ => unreachable!(),
                        }
                    })),
                    ..Default::default()
                }
            });
            let mut costs = SourceReaderCosts::default();
            assert!(
                inspect_git_tree_with_costs(&workspace, &root, Some(&mut costs)).is_err(),
                "{phase}/{mutation}"
            );
            if phase == "last_after" {
                assert_eq!(
                    costs.workspace_git_command_starts, 7,
                    "known tree-response drift settles before another native child"
                );
            }
            assert!(
                fired.load(std::sync::atomic::Ordering::SeqCst),
                "{phase}/{mutation}"
            );
            workspace_metadata_test_hooks::STATE.with(|state| {
                let state = state.borrow();
                let queries = state.counts.get("tree_query").copied().unwrap_or(0);
                assert_eq!(
                    queries,
                    if phase == "tree_before" {
                        0
                    } else if phase == "tree_close"
                        || phase == "tree_settled"
                        || phase == "last_after"
                    {
                        8
                    } else {
                        1
                    },
                    "fresh guard before further read {phase}/{mutation}"
                );
                assert_eq!(state.counts["spawn"], state.counts["reap"]);
                assert_eq!(state.counts["drain_spawn"], state.counts["drain_join"]);
            });
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let (_dir, workspace, tree) = workspace_many_tree_fixture("sha1", 8);
        let root_path = workspace
            .join(".git/objects")
            .join(tree[..2].to_ascii_lowercase())
            .join(tree[2..].to_ascii_lowercase());
        let original = fs::read(&root_path).unwrap();
        fs::remove_file(&root_path).unwrap();
        assert!(inspect_git_tree(&workspace, &tree).is_err());
        fs::write(&root_path, &original).unwrap();
        inspect_git_tree(&workspace, &tree).unwrap();
        let loose = workspace
            .join(".git/objects")
            .join(tree[..2].to_ascii_lowercase())
            .join(tree[2..].to_ascii_lowercase());
        fs::remove_file(&loose).unwrap();
        fs::write(loose, b"current wrong loose body").unwrap();
        assert!(
            inspect_git_tree(&workspace, &tree).is_err(),
            "no body or negative authority survives an inspection"
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_tree_owner_protocol_and_settlement_refuses_partial_proof() {
        let mut unrelated = Command::new("python3")
            .arg("-c")
            .arg("import time; time.sleep(120)")
            .spawn()
            .unwrap();
        for width in [40, 64] {
            let leaf = vec![17; width / 2];
            let mut body = b"100644 opaque\xff\t\n\\/name\0".to_vec();
            body.extend(&leaf);
            let oid_for = |body: &[u8]| {
                let canonical = [format!("tree {}\0", body.len()).as_bytes(), body].concat();
                if width == 40 {
                    hex::encode(sha1::Sha1::digest(&canonical))
                } else {
                    hex::encode(Sha256::digest(&canonical))
                }
            };
            let oid = oid_for(&body);
            let frame = |oid: &str, body: &[u8]| {
                [
                    format!("{oid} tree {}\n", body.len()).as_bytes(),
                    body,
                    b"\n",
                ]
                .concat()
            };
            let valid = frame(&oid, &body);
            type TreeResponse = (&'static str, String, Vec<u8>, Vec<u8>, u8, bool, bool);
            let mut cases: Vec<TreeResponse> = vec![
                ("valid", oid.clone(), valid.clone(), vec![], 0, false, true),
                (
                    "stderr_pressure",
                    oid.clone(),
                    valid.clone(),
                    vec![],
                    0,
                    false,
                    true,
                ),
                (
                    "empty",
                    oid_for(b""),
                    frame(&oid_for(b""), b""),
                    vec![],
                    0,
                    false,
                    true,
                ),
                (
                    "missing",
                    oid.clone(),
                    format!("{oid} missing\n").into_bytes(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "wrong_oid",
                    oid.clone(),
                    frame(&"0".repeat(width), &body),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "wrong_width",
                    oid.clone(),
                    frame(&"0".repeat(if width == 40 { 64 } else { 40 }), &body),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "wrong_kind",
                    oid.clone(),
                    valid.clone(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "wrong_hash",
                    oid.clone(),
                    {
                        let mut changed = body.clone();
                        *changed.last_mut().unwrap() ^= 1;
                        frame(&oid, &changed)
                    },
                    vec![],
                    0,
                    true,
                    false,
                ),
                ("no_response", oid.clone(), vec![], vec![], 0, true, false),
                (
                    "overflow",
                    oid.clone(),
                    format!("{oid} tree 18446744073709551616\n").into_bytes(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "large_truncated",
                    oid.clone(),
                    format!("{oid} tree 18446744073709551615\n").into_bytes(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "bad_header",
                    oid.clone(),
                    vec![255, b'\n'],
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "oversized_header",
                    oid.clone(),
                    vec![b'x'; 300],
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "late_output",
                    oid.clone(),
                    valid.clone(),
                    b"late".to_vec(),
                    0,
                    false,
                    false,
                ),
                (
                    "late_status",
                    oid.clone(),
                    valid.clone(),
                    vec![],
                    7,
                    false,
                    false,
                ),
                (
                    "duplicate",
                    oid.clone(),
                    [valid.as_slice(), valid.as_slice()].concat(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "wrong_newline",
                    oid.clone(),
                    [&valid[..valid.len() - 1], b"!"].concat(),
                    vec![],
                    0,
                    true,
                    false,
                ),
                (
                    "truncated_body",
                    oid.clone(),
                    valid[..valid.len() - 3].to_vec(),
                    vec![],
                    0,
                    true,
                    false,
                ),
            ];
            cases[6].2 = [
                format!("{oid} blob {}\n", body.len()).as_bytes(),
                &body,
                b"\n",
            ]
            .concat();
            for bad in [
                b"1008 x\0".as_slice(),
                b"100644 \0",
                b"100644 no-nul",
                b"100644 x\0short",
                b"100",
                b"160000 link\0",
            ] {
                let bad = bad.to_vec();
                let bad_oid = oid_for(&bad);
                cases.push((
                    "malformed_tree",
                    bad_oid.clone(),
                    frame(&bad_oid, &bad),
                    vec![],
                    0,
                    true,
                    false,
                ));
            }
            let mut gitlink = b"160000 link\0".to_vec();
            gitlink.extend(&leaf);
            let gitlink_oid = oid_for(&gitlink);
            cases.push((
                "gitlink",
                gitlink_oid.clone(),
                frame(&gitlink_oid, &gitlink),
                vec![],
                0,
                true,
                true,
            ));
            for (name, request, response, tail, status, immediate, success) in cases {
                workspace_metadata_test_hooks::STATE
                    .with(|state| *state.borrow_mut() = Default::default());
                let result = run_workspace_git_child(
                    workspace_protocol_child(
                        &response,
                        &tail,
                        if name == "stderr_pressure" {
                            1024 * 1024
                        } else {
                            0
                        },
                        status,
                        immediate,
                    ),
                    &mut None,
                    |owner| {
                        let mut edges = Vec::new();
                        owner.tree(&request, width, |oid, tree| edges.push((oid, tree)))?;
                        owner.finish()?;
                        Ok(edges)
                    },
                );
                assert_eq!(result.is_ok(), success, "{width}/{name}");
                if name == "valid" {
                    assert_eq!(result.unwrap(), [(hex::encode(&leaf), false)]);
                } else if name == "gitlink" {
                    assert!(
                        result.unwrap().is_empty(),
                        "submodule commits are external to the parent object closure"
                    );
                }
                workspace_metadata_test_hooks::STATE.with(|state| {
                    let state = state.borrow();
                    assert_eq!(state.counts["spawn"], state.counts["reap"]);
                    assert_eq!(state.counts["drain_spawn"], state.counts["drain_join"]);
                    assert!(state.retained_stderr <= 16 * 1024);
                    if name == "stderr_pressure" {
                        assert_eq!(state.retained_stderr, 16 * 1024);
                    }
                    for pid in &state.owned_pids {
                        assert!(!Path::new(&format!("/proc/{pid}")).exists());
                    }
                });
                assert!(unrelated.try_wait().unwrap().is_none());
            }
            for fault in ["spawn", "read", "join", "closed_input", "broken_pipe"] {
                workspace_metadata_test_hooks::STATE.with(|state| {
                    *state.borrow_mut() = workspace_metadata_test_hooks::State {
                        fail_drain_spawn: fault == "spawn",
                        fail_drain_read: fault == "read",
                        fail_drain_join: fault == "join",
                        ..Default::default()
                    }
                });
                let command = if fault == "broken_pipe" {
                    let mut c = Command::new("python3");
                    c.arg("-c").arg("pass");
                    c
                } else {
                    workspace_protocol_child(&valid, b"", 4096, 0, false)
                };
                let result = run_workspace_git_child(command, &mut None, |owner| {
                    if fault == "closed_input" {
                        owner.input.take();
                    }
                    if fault == "broken_pipe" {
                        owner.child.wait()?;
                    }
                    owner.tree(&oid, width, |_, _| {})?;
                    owner.finish()
                });
                assert!(result.is_err(), "{fault}");
                workspace_metadata_test_hooks::STATE.with(|state| {
                    let state = state.borrow();
                    assert_eq!(state.counts["spawn"], state.counts["reap"]);
                    assert_eq!(
                        state.counts.get("drain_spawn"),
                        state.counts.get("drain_join")
                    );
                    for pid in &state.owned_pids {
                        assert!(!Path::new(&format!("/proc/{pid}")).exists());
                    }
                });
            }
        }
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    fn workspace_protocol_child(
        header: &[u8],
        tail: &[u8],
        stderr: usize,
        status: u8,
        immediate: bool,
    ) -> Command {
        let mut command = Command::new("python3");
        command.arg("-c").arg("import sys\nsys.stdin.buffer.readline()\nsys.stderr.buffer.write(b'e'*int(sys.argv[3])); sys.stderr.buffer.flush()\nsys.stdout.buffer.write(bytes.fromhex(sys.argv[1])); sys.stdout.buffer.flush()\nif sys.argv[5] == '0': sys.stdin.buffer.read()\nsys.stdout.buffer.write(bytes.fromhex(sys.argv[2])); sys.stdout.buffer.flush()\nsys.exit(int(sys.argv[4]))")
            .arg(hex::encode(header)).arg(hex::encode(tail)).arg(stderr.to_string()).arg(status.to_string()).arg(if immediate { "1" } else { "0" });
        command
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_owner_rejects_protocol_and_late_settlement_faults() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let valid = format!("{oid} blob 7\n");
        let mut unrelated = Command::new("python3")
            .arg("-c")
            .arg("import time; time.sleep(30)")
            .spawn()
            .unwrap();
        let cases = [
            (
                "valid",
                valid.as_bytes().to_vec(),
                Vec::new(),
                0,
                false,
                true,
            ),
            (
                "stderr_pressure",
                valid.as_bytes().to_vec(),
                Vec::new(),
                0,
                false,
                true,
            ),
            (
                "missing",
                format!("{oid} missing\n").into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "wrong_oid",
                format!("{} blob 7\n", "1".repeat(40)).into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "wrong_width",
                format!("{} blob 7\n", "0".repeat(64)).into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "malformed",
                format!("{oid} blob 7 extra\n").into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            ("nontext", vec![255, b'\n'], Vec::new(), 0, false, false),
            ("oversize", vec![b'x'; 300], Vec::new(), 0, true, false),
            (
                "truncated",
                valid.trim_end().as_bytes().to_vec(),
                Vec::new(),
                0,
                true,
                false,
            ),
            (
                "invalid_size",
                format!("{oid} blob -7\n").into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "overflow",
                format!("{oid} blob 18446744073709551616\n").into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "duplicate",
                format!("{valid}{valid}").into_bytes(),
                Vec::new(),
                0,
                false,
                false,
            ),
            (
                "late_output",
                valid.as_bytes().to_vec(),
                b"unexpected late stdout".to_vec(),
                0,
                false,
                false,
            ),
            (
                "late_status",
                valid.as_bytes().to_vec(),
                Vec::new(),
                7,
                false,
                false,
            ),
            ("read_eof", Vec::new(), Vec::new(), 0, true, false),
        ];
        for (name, header, tail, status, immediate, success) in cases {
            workspace_metadata_test_hooks::STATE
                .with(|state| *state.borrow_mut() = Default::default());
            let mut costs = SourceReaderCosts::default();
            let result = run_workspace_git_child(
                workspace_protocol_child(
                    &header,
                    &tail,
                    if name == "stderr_pressure" {
                        1024 * 1024
                    } else {
                        0
                    },
                    status,
                    immediate,
                ),
                &mut Some(&mut costs),
                |owner| {
                    let metadata = owner.query(oid, 40)?;
                    owner.finish()?;
                    Ok(metadata)
                },
            );
            assert_eq!(result.is_ok(), success, "{name}");
            assert_eq!(costs.workspace_git_command_starts, 1);
            assert_eq!(costs.native_spawns, 0);
            workspace_metadata_test_hooks::STATE.with(|state| {
                let state = state.borrow();
                assert_eq!(state.counts["spawn"], 1, "{name}");
                assert_eq!(state.counts["reap"], 1, "{name}");
                assert_eq!(state.counts["drain_spawn"], 1, "{name}");
                assert_eq!(state.counts["drain_join"], 1, "{name}");
                assert_eq!(state.counts["peak"], 1, "{name}");
                assert_eq!(state.counts["drain_peak"], 1, "{name}");
                assert!(state.retained_stderr <= 16 * 1024);
                if name == "stderr_pressure" {
                    assert_eq!(state.retained_stderr, 16 * 1024);
                }
                for pid in &state.owned_pids {
                    assert!(
                        !Path::new(&format!("/proc/{pid}")).exists(),
                        "{name}: exact child must be reaped"
                    );
                }
            });
            assert!(
                unrelated.try_wait().unwrap().is_none(),
                "{name}: unrelated owned fixture survives"
            );
        }
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[test]
    fn workspace_metadata_missing_native_object_and_owned_input_failures_refuse() {
        let (_dir, workspace, _tree) = workspace_metadata_fixture("sha1", true, false);
        let repository = GitRepository {
            git_dir: workspace.join(".git"),
            work_tree: workspace,
        };
        let absent = "f".repeat(40);
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        assert!(run_workspace_git_child(
            workspace_git_command(&repository, &["cat-file", "--batch-check"]),
            &mut None,
            |owner| {
                owner.query(&absent, 40)?;
                owner.finish()
            }
        )
        .is_err());
        assert!(run_workspace_git_child(
            workspace_git_command(&repository, &["cat-file", "--batch-check"]),
            &mut None,
            |owner| {
                owner.input.take();
                owner.query(&absent, 40)?;
                owner.finish()
            }
        )
        .is_err());
        let fixture = tempfile::tempdir().unwrap();
        let mut costs = SourceReaderCosts::default();
        assert!(run_workspace_git_child(
            Command::new(fixture.path().join("nonexistent-owned-git")),
            &mut Some(&mut costs),
            |owner| owner.finish()
        )
        .is_err());
        assert_eq!(costs.workspace_git_command_starts, 1);
        workspace_metadata_test_hooks::STATE.with(|state| {
            let state = state.borrow();
            assert_eq!(state.counts["spawn"], 2);
            assert_eq!(state.counts["reap"], 2);
            assert_eq!(state.counts["drain_spawn"], 2);
            assert_eq!(state.counts["drain_join"], 2);
        });
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[test]
    fn workspace_metadata_native_owner_accepts_all_kinds_and_fresh_inspections() {
        for format in ["sha1", "sha256"] {
            let (_dir, workspace, tree) = workspace_metadata_fixture(format, true, false);
            let git_dir = workspace.join(".git");
            let commit_body = format!("tree {tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture commit\n");
            let commit = fixture_git(
                &git_dir,
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                Some(commit_body.as_bytes()),
            );
            let tag_body = format!("object {commit}\ntype commit\ntag fixture\ntagger Fixture <fixture@example.invalid> 1 +0000\n\nfixture tag\n");
            let tag = fixture_git(
                &git_dir,
                &["hash-object", "-t", "tag", "-w", "--stdin"],
                Some(tag_body.as_bytes()),
            );
            let blob_body = b"fixture blob";
            let blob = fixture_git(&git_dir, &["hash-object", "-w", "--stdin"], Some(blob_body));
            let repository = GitRepository {
                work_tree: workspace.clone(),
                git_dir: git_dir.clone(),
            };
            let mut actual = Vec::new();
            run_workspace_git_child(
                workspace_git_command(&repository, &["cat-file", "--batch-check"]),
                &mut None,
                |owner| {
                    for (id, kind, size) in [
                        (
                            &tree,
                            "tree",
                            fixture_git(&git_dir, &["cat-file", "-s", &tree], None)
                                .parse()
                                .unwrap(),
                        ),
                        (&commit, "commit", commit_body.len() as u64),
                        (&tag, "tag", tag_body.len() as u64),
                        (&blob, "blob", blob_body.len() as u64),
                    ] {
                        let record = owner.query(&id.to_ascii_uppercase(), id.len())?;
                        assert_eq!(record, (kind.to_string(), size));
                        actual.push(record);
                    }
                    owner.finish()
                },
            )
            .unwrap();
            assert_eq!(actual.len(), 4);
            workspace_metadata_test_hooks::STATE
                .with(|state| *state.borrow_mut() = Default::default());
            let first = inspect_git_tree(&workspace, &tree).unwrap();
            fixture_git(&git_dir, &["config", "core.ignorecase", "true"], None);
            let second = inspect_git_tree(&workspace, &tree).unwrap();
            assert_eq!(
                (first.identity, first.closure_bytes, first.closure_sha256),
                (second.identity, second.closure_bytes, second.closure_sha256)
            );
            workspace_metadata_test_hooks::STATE
                .with(|state| *state.borrow_mut() = Default::default());
            let selected = fs::read_dir(git_dir.join("objects/pack"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.extension().is_some_and(|value| value == "pack"))
                .unwrap();
            fs::remove_file(selected).unwrap();
            assert!(inspect_git_tree(&workspace, &tree).is_err());
            workspace_metadata_test_hooks::STATE
                .with(|state| assert!(state.borrow().records.is_empty()));
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_owner_settles_injected_io_faults() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        for fault in ["drain_spawn", "drain_read", "write"] {
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    fail_drain_spawn: fault == "drain_spawn",
                    fail_drain_read: fault == "drain_read",
                    ..Default::default()
                }
            });
            let mut costs = SourceReaderCosts::default();
            let command = if fault == "write" {
                let mut command = Command::new("python3");
                command.arg("-c").arg("pass");
                command
            } else {
                workspace_protocol_child(format!("{oid} blob 7\n").as_bytes(), b"", 4096, 0, false)
            };
            let result = run_workspace_git_child(command, &mut Some(&mut costs), |owner| {
                if fault == "write" {
                    let started = Instant::now();
                    while owner.child.try_wait()?.is_none() {
                        assert!(
                            started.elapsed() < Duration::from_secs(2),
                            "finite write-error child must exit"
                        );
                        std::thread::yield_now();
                    }
                }
                owner.query(oid, 40)?;
                owner.finish()
            });
            assert!(result.is_err(), "{fault}");
            assert_eq!(costs.workspace_git_command_starts, 1);
            workspace_metadata_test_hooks::STATE.with(|state| {
                let state = state.borrow();
                assert_eq!(state.counts["spawn"], 1);
                assert_eq!(state.counts["reap"], 1);
                assert_eq!(state.counts["all_spawn"], state.counts["all_reap"]);
                assert_eq!(
                    state.counts.get("drain_spawn"),
                    state.counts.get("drain_join")
                );
                for pid in &state.owned_pids {
                    assert!(!Path::new(&format!("/proc/{pid}")).exists());
                }
                #[cfg(target_os = "linux")]
                for tid in &state.drainer_tids {
                    assert!(!Path::new(&format!("/proc/self/task/{tid}")).exists());
                }
            });
        }
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_optional_refusal_preserves_complete_native_bundle() {
        let fixture = reuse_fixture(true);
        let baseline = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")),
        )
        .unwrap();
        let workspace = fixture.dir.path().join("workspace");
        let git_dir = workspace.join(".git");
        fixture_git(&git_dir, &["init", "-q"], None);
        copy_fixture_objects(&fixture.store, &git_dir.join("objects"));
        let pack_dir = git_dir.join("objects/pack");
        let mut refusals = 0;
        workspace_metadata_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = workspace_metadata_test_hooks::State {
                barrier: Some(Box::new(move |phase, _| {
                    if phase == "settled" {
                        refusals += 1;
                        fs::write(
                            pack_dir.join(format!("owned-mutation-{refusals}.keep")),
                            b"current fixture entry",
                        )
                        .unwrap();
                    }
                })),
                ..Default::default()
            }
        });
        let costs = Arc::new(std::sync::Mutex::new(None));
        let observed = costs.clone();
        let refused = export_exact_session(
            &fixture.inventory,
            "ses_exact",
            ExportOptions::new(fixture.dir.path().join("extract")).with_progress_observer(
                move |event| {
                    if event.phase == "saved_objects" && event.state == "completed" {
                        *observed.lock().unwrap() = event.reader_costs.clone();
                    }
                },
            ),
        )
        .unwrap();
        assert_eq!(
            fs::read(&baseline.payload_path).unwrap(),
            fs::read(&refused.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(baseline.manifest()).unwrap(),
            serde_json::to_value(refused.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(baseline.manifest()).unwrap(),
            source_graph_fingerprint(refused.manifest()).unwrap()
        );
        let costs = costs.lock().unwrap();
        let costs = costs.as_ref().unwrap();
        assert_eq!(costs.workspace_git_refusals, 9);
        assert_eq!(costs.workspace_git_successes, 0);
        assert_eq!(costs.native_queries, 30);
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_selected_symlink_refusal_preserves_complete_native_bundle() {
        for phase in ["traversed", "settled"] {
            let fixture = reuse_fixture(true);
            let baseline = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            )
            .unwrap();
            let workspace = fixture.dir.path().join("workspace");
            let git_dir = workspace.join(".git");
            fixture_git(&git_dir, &["init", "-q"], None);
            copy_fixture_objects(&fixture.store, &git_dir.join("objects"));
            let loose_path = git_dir
                .join("objects")
                .join(&fixture.blob[..2])
                .join(&fixture.blob[2..]);
            fs::create_dir_all(loose_path.parent().unwrap()).unwrap();
            let body = fixture_git(&git_dir, &["cat-file", "blob", &fixture.blob], None);
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            write!(encoder, "blob {}\0{body}", body.len()).unwrap();
            let parked = fixture.dir.path().join("outside-workspace-loose-object");
            fs::write(&parked, encoder.finish().unwrap()).unwrap();
            // Restore the workspace path only before the next independently
            // guarded native closure read. Each workspace inspection still
            // sees the redirect through its complete acceptance boundary.
            let cleanup_path = loose_path.clone();
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    before_reference: Some(Box::new(move |_| {
                        if cleanup_path.symlink_metadata().is_ok() {
                            fs::remove_file(&cleanup_path).unwrap();
                        }
                    })),
                    ..Default::default()
                }
            });
            let redirects = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let barrier_redirects = redirects.clone();
            let final_cleanup = loose_path.clone();
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    barrier: Some(Box::new(move |at, _| {
                        if at == phase {
                            barrier_redirects.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            std::os::unix::fs::symlink(&parked, &loose_path).unwrap();
                        }
                    })),
                    ..Default::default()
                }
            });
            let costs = Arc::new(std::sync::Mutex::new(None));
            let completed_costs = costs.clone();
            let refused = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")).with_progress_observer(
                    move |event| {
                        if event.phase == "saved_objects" && event.state == "completed" {
                            *completed_costs.lock().unwrap() = event.reader_costs.clone();
                        }
                    },
                ),
            )
            .unwrap();
            assert_eq!(redirects.load(std::sync::atomic::Ordering::SeqCst), 9);
            fs::remove_file(final_cleanup).unwrap();
            assert_eq!(
                fs::read(&baseline.payload_path).unwrap(),
                fs::read(&refused.payload_path).unwrap(),
                "{phase}: no unqualified workspace asset may enter the native payload"
            );
            assert_eq!(
                serde_json::to_value(baseline.manifest()).unwrap(),
                serde_json::to_value(refused.manifest()).unwrap()
            );
            assert_eq!(
                source_graph_fingerprint(baseline.manifest()).unwrap(),
                source_graph_fingerprint(refused.manifest()).unwrap()
            );
            let costs = costs.lock().unwrap();
            let costs = costs.as_ref().unwrap();
            assert_eq!(costs.workspace_git_refusals, 9);
            assert_eq!(costs.workspace_git_successes, 0);
            assert_eq!(costs.native_queries, 30);
            eprintln!("selected redirect {phase}: 9 executed, 9 workspace refusals, 0 successes; complete native payload/manifest/graph preserved");
            workspace_metadata_test_hooks::STATE.with(|state| {
                let state = state.borrow();
                assert!(state.records.is_empty());
                assert_eq!(state.counts.get("spawn"), state.counts.get("reap"));
                assert_eq!(
                    state.counts.get("drain_spawn"),
                    state.counts.get("drain_join")
                );
            });
            snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
            workspace_metadata_test_hooks::STATE
                .with(|state| *state.borrow_mut() = Default::default());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn workspace_metadata_complete_export_measures_owned_process_pipe_and_drainer_peaks() {
        let fixture = reuse_fixture(true);
        packed_pressure_stores(&fixture);
        let workspace = fixture.dir.path().join("workspace");
        let git_dir = workspace.join(".git");
        fixture_git(&git_dir, &["init", "-q"], None);
        copy_fixture_objects(&fixture.store, &git_dir.join("objects"));
        let mut exports = Vec::new();
        let mut peaks = Vec::new();
        for legacy in [true, false] {
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    aggregate_disabled: true,
                    ..Default::default()
                }
            });
            let drainer_peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let observed = drainer_peak.clone();
            workspace_metadata_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = workspace_metadata_test_hooks::State {
                    legacy,
                    barrier: Some(Box::new(move |phase, _| {
                        if phase == "before_query" {
                            let actual = fs::read_dir("/proc/self/task")
                                .unwrap()
                                .filter_map(Result::ok)
                                .filter_map(|entry| {
                                    fs::read_to_string(entry.path().join("comm")).ok()
                                })
                                .filter(|name| {
                                    name.starts_with("snapshot-git-st")
                                        || name.starts_with("workspace-git-s")
                                })
                                .count();
                            observed.fetch_max(actual, std::sync::atomic::Ordering::SeqCst);
                        }
                    })),
                    ..Default::default()
                }
            });
            let exported = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            )
            .unwrap();
            let body_counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(body_counts["packed_peak"], 4);
            assert_eq!(body_counts["packed_drain_peak"], 4);
            assert_eq!(body_counts["packed_spawn"], body_counts["packed_reap"]);
            assert_eq!(
                body_counts["packed_drain_spawn"],
                body_counts["packed_drain_join"]
            );
            let counts = workspace_metadata_test_hooks::STATE.with(|state| {
                let state = state.borrow();
                assert_eq!(state.counts["all_spawn"], state.counts["all_reap"]);
                assert_eq!(state.counts["all_peak"], 1);
                for tid in &state.drainer_tids {
                    assert!(
                        !Path::new(&format!("/proc/self/task/{tid}")).exists(),
                        "exact owned stderr drainer joined"
                    );
                }
                state.counts.clone()
            });
            assert_eq!(counts["os_workspace_peak"], 1);
            assert_eq!(counts["os_body_peak"], 4);
            assert_eq!(counts["os_process_peak"], 5);
            if !legacy {
                assert_eq!(counts["os_pipe_peak"], 15);
                assert_eq!(counts["drain_peak"], 1);
                assert!(drainer_peak.load(std::sync::atomic::Ordering::SeqCst) >= 5);
            }
            eprintln!("actual OS complete export legacy={legacy} peaks={counts:?}; observed named drainer threads={}", drainer_peak.load(std::sync::atomic::Ordering::SeqCst));
            exports.push((
                fs::read(&exported.payload_path).unwrap(),
                serde_json::to_value(exported.manifest()).unwrap(),
                source_graph_fingerprint(exported.manifest()).unwrap(),
            ));
            peaks.push(counts["os_process_peak"]);
        }
        assert_eq!(exports[0], exports[1]);
        assert_eq!(peaks, [5, 5]);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        workspace_metadata_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
    }

    #[cfg(unix)]
    #[test]
    fn verified_aggregate_reduces_late_hit_startups_and_preserves_complete_export() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, late_body) = packed_pressure_stores(&fixture);
        let mut reader_counts = Vec::new();
        let mut exports = Vec::new();
        for disabled in [true, false] {
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    aggregate_disabled: disabled,
                    ..Default::default()
                };
            });
            let mut decoders = SnapshotPackedDecoders::default();
            decoders
                .qualify(
                    fixture.store.parent().unwrap(),
                    &fixture.dir.path().join("workspace/.git/objects"),
                    &stores,
                )
                .unwrap();
            for _ in 0..8 {
                let Some(SnapshotObjectSource::Packed { kind, body }) =
                    decoders.read(&stores, &late_id).unwrap()
                else {
                    panic!("each repeated current late hit must remain readable");
                };
                assert_eq!(kind, "blob");
                assert_eq!(body, late_body);
            }
            decoders.finish().unwrap();
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(counts["packed_validate"], 8);
            assert_eq!(counts["packed_spawn"], counts["packed_reap"]);
            assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
            assert!(counts["packed_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
            assert!(counts["packed_drain_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
            reader_counts.push(counts);
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    aggregate_disabled: disabled,
                    ..Default::default()
                };
            });
            let exported = export_exact_session(
                &fixture.inventory,
                "ses_exact",
                ExportOptions::new(fixture.dir.path().join("extract")),
            )
            .unwrap();
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(counts["packed_validate"], 30);
            assert_eq!(counts["packed_spawn"], counts["packed_reap"]);
            assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
            assert!(counts["packed_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
            assert!(counts["packed_drain_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
            exports.push((exported, counts));
        }
        assert_eq!(
            fs::read(&exports[0].0.payload_path).unwrap(),
            fs::read(&exports[1].0.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(exports[0].0.manifest()).unwrap(),
            serde_json::to_value(exports[1].0.manifest()).unwrap()
        );
        assert_eq!(
            source_graph_fingerprint(exports[0].0.manifest()).unwrap(),
            source_graph_fingerprint(exports[1].0.manifest()).unwrap()
        );
        eprintln!(
            "current late hit measurements: {reader_counts:?}; complete export launches: {} -> {}",
            exports[0].1["packed_spawn"], exports[1].1["packed_spawn"]
        );
        assert!(
            reader_counts[1]["packed_spawn"] < reader_counts[0]["packed_spawn"],
            "verified aggregate must remove repeated late-hit native startup pressure"
        );
        assert!(
            exports[1].1["packed_spawn"] < exports[0].1["packed_spawn"],
            "complete output equality must retain the startup saving"
        );
    }

    #[test]
    fn packed_decoder_residency_bounds_real_alternates_without_changing_hits_or_misses() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, late_body) = packed_pressure_stores(&fixture);
        let absent = hex::encode(sha1::Sha1::digest(
            b"blob 30\0genuinely absent packed object",
        ));
        let mut outputs = Vec::new();
        let mut measurements = Vec::new();
        for limit in [Some(stores.len()), None, Some(2)] {
            snapshot_reuse_test_hooks::STATE.with(|state| {
                *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                    aggregate_disabled: true,
                    ..Default::default()
                }
            });
            let mut decoders = SnapshotPackedDecoders {
                residency_limit: limit,
                ..Default::default()
            };
            decoders
                .qualify(
                    fixture.store.parent().unwrap(),
                    &fixture.dir.path().join("workspace/.git/objects"),
                    &stores,
                )
                .unwrap();
            let mut current = Vec::new();
            for _ in 0..2 {
                let Some(SnapshotObjectSource::Packed { kind, body }) =
                    decoders.read(&stores, &late_id).unwrap()
                else {
                    panic!("the later qualified alternate must remain readable under pressure");
                };
                assert_eq!(kind, "blob");
                assert_eq!(body, late_body);
                current.push(compress_snapshot_object(&kind, &body).unwrap());
                assert!(decoders.read(&stores, &absent).unwrap().is_none());
            }
            decoders.finish().unwrap();
            let counts =
                snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
            assert_eq!(
                counts["packed_query"],
                2 * (stores.len() - 1 + stores.len())
            );
            assert_eq!(counts["packed_validate"], 2);
            assert_eq!(counts["packed_spawn"], counts["packed_reap"]);
            assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
            outputs.push(current);
            measurements.push(counts);
        }
        assert_eq!(outputs[0], outputs[1]);
        assert_eq!(outputs[0], outputs[2]);
        assert_eq!(
            measurements[0]["packed_query"],
            measurements[1]["packed_query"]
        );
        assert_eq!(
            measurements[0]["packed_query"],
            measurements[2]["packed_query"]
        );
        eprintln!("actual packed pressure measurements: {measurements:?}");
        assert!(measurements[1]["packed_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
        assert!(measurements[1]["packed_drain_peak"] <= MAX_RESIDENT_SNAPSHOT_DECODERS);
        assert!(
            measurements[2]["packed_peak"] <= 2,
            "live Git processes must be bounded independently of valid alternate count"
        );
        assert!(measurements[2]["packed_drain_peak"] <= 2);
    }

    fn packed_pressure_stores(fixture: &ReuseFixture) -> (Vec<PathBuf>, String, Vec<u8>) {
        let mut alternates = Vec::new();
        let mut last = None;
        for index in 0..5 {
            let git_dir = fixture
                .dir
                .path()
                .join(format!("workspace/alternate-{index}"));
            fs::create_dir(&git_dir).unwrap();
            fixture_git(&git_dir, &["init", "--bare", "-q"], None);
            let body = format!("owned alternate {index}").into_bytes();
            let id = fixture_git(&git_dir, &["hash-object", "-w", "--stdin"], Some(&body));
            fixture_git(&git_dir, &["update-ref", "refs/fixture/object", &id], None);
            fixture_git(&git_dir, &["repack", "-a", "-d"], None);
            fixture_git(&git_dir, &["prune-packed"], None);
            let store = git_dir.join("objects");
            assert!(!store.join(&id[..2]).join(&id[2..]).exists());
            alternates.push(store);
            last = Some((id, body));
        }
        fs::write(
            fixture.store.join("info/alternates"),
            alternates
                .iter()
                .map(|path| format!("{}\n", path.display()))
                .collect::<String>(),
        )
        .unwrap();
        let stores = qualified_snapshot_stores(
            fixture.store.parent().unwrap(),
            &fixture.dir.path().join("workspace/.git/objects"),
        )
        .unwrap();
        assert_eq!(&stores[..5], alternates);
        assert_eq!(stores.last(), Some(&fixture.store));
        let (id, body) = last.unwrap();
        (stores, id, body)
    }

    #[cfg(unix)]
    #[test]
    fn packed_decoder_pressure_refuses_evicted_late_exit_and_joins_every_child() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, _) = packed_pressure_stores(&fixture);
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                aggregate_disabled: true,
                ..Default::default()
            }
        });
        let mut decoders = SnapshotPackedDecoders {
            storage: Some(snapshot_packed_storage(&stores).unwrap()),
            residency_limit: Some(2),
            ..Default::default()
        };
        // An owned natural-exit fixture supplies a valid miss, then reports a
        // late decoder failure when eviction closes stdin. No foreign process
        // or host process-kill suite is involved.
        let mut command = Command::new("sh");
        command.arg("-c").arg(
            r#"while IFS= read -r oid; do printf '%s missing\n' "$oid"; done
            printf '%s' 'owned pressure fixture late failure' >&2
            exit 9"#,
        );
        let failed = SnapshotPackedDecoder::from_command(command).unwrap();
        let failed_pid = failed.child.id();
        decoders.children.insert(stores[0].clone(), failed);
        let result = decoders.read(&stores, &late_id);
        assert!(
            matches!(result, Err(TransferError::Blocked(ref reason)) if reason.contains("owned pressure fixture late failure")),
            "eviction must refuse the late failure before accepting later valid bytes"
        );
        assert!(decoders
            .children
            .values()
            .all(|child| child.child.id() != failed_pid));
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_query"], 2);
        assert_eq!(counts["packed_spawn"], 2);
        assert_eq!(counts["packed_reap"], 1);
        assert_eq!(counts["packed_drain_join"], 1);
        decoders.finish().unwrap();
        assert!(decoders.children.is_empty());
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_reap"], counts["packed_spawn"]);
        assert_eq!(counts["packed_drain_join"], counts["packed_drain_spawn"]);
        assert_eq!(counts["packed_peak"], 2);
        assert_eq!(counts["packed_drain_peak"], 2);
    }

    #[test]
    fn packed_decoder_pressure_replaced_pack_cannot_supply_retired_bytes() {
        let fixture = reuse_fixture(true);
        let (stores, late_id, late_body) = packed_pressure_stores(&fixture);
        snapshot_reuse_test_hooks::STATE.with(|state| {
            *state.borrow_mut() = snapshot_reuse_test_hooks::State {
                aggregate_disabled: true,
                ..Default::default()
            }
        });
        let mut decoders = SnapshotPackedDecoders {
            residency_limit: Some(2),
            ..Default::default()
        };
        let Some(SnapshotObjectSource::Packed { body, .. }) =
            decoders.read(&stores, &late_id).unwrap()
        else {
            panic!("actual late store must be warm before replacement");
        };
        assert_eq!(body, late_body);
        // Retain an open descriptor for the late store while also exhausting
        // the residency limit with a genuinely absent lookup.
        let absent = "0".repeat(40);
        assert!(decoders.read(&stores, &absent).unwrap().is_none());
        assert!(decoders.children.contains_key(&stores[4]));
        let replacement_files = fs::read_dir(stores[0].join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        for original in fs::read_dir(stores[4].join("pack")).unwrap() {
            let original = original.unwrap().path();
            let replacement = replacement_files
                .iter()
                .find(|path| path.extension() == original.extension())
                .unwrap();
            fs::remove_file(&original).unwrap();
            fs::copy(replacement, original).unwrap();
        }
        assert!(
            decoders.read(&stores, &late_id).unwrap().is_none(),
            "pressure must not preserve retired pack descriptor authority"
        );
        decoders.finish().unwrap();
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_query"], stores.len() - 1 + 2 * stores.len());
        assert_eq!(counts["packed_validate"], 1);
        assert_eq!(counts["packed_spawn"], counts["packed_reap"]);
        assert_eq!(counts["packed_drain_spawn"], counts["packed_drain_join"]);
        assert_eq!(counts["packed_peak"], 2);
        assert_eq!(counts["packed_drain_peak"], 2);
    }

    #[test]
    fn packed_decoder_cold_miss_observes_new_pack_and_reaps_on_drop() {
        let fixture = reuse_fixture(true);
        let store = std::slice::from_ref(&fixture.store);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let mut decoders = SnapshotPackedDecoders::default();
        // The native Git child genuinely queries and misses this object.
        let body = b"new object after native cold miss";
        let mut raw = format!("blob {}\0", body.len()).into_bytes();
        raw.extend_from_slice(body);
        let id = hex::encode(sha1::Sha1::digest(raw));
        assert!(decoders.read(store, &id).unwrap().is_none());
        assert_eq!(
            fixture_git(
                fixture.store.parent().unwrap(),
                &["hash-object", "-w", "--stdin"],
                Some(body)
            ),
            id
        );
        fixture_git(
            fixture.store.parent().unwrap(),
            &["update-ref", "refs/fixture/new", &id],
            None,
        );
        fixture_git(
            fixture.store.parent().unwrap(),
            &["repack", "-a", "-d"],
            None,
        );
        fixture_git(fixture.store.parent().unwrap(), &["prune-packed"], None);
        assert!(!fixture_object_path(&fixture, &id).exists());
        let Some(SnapshotObjectSource::Packed { body: current, .. }) =
            decoders.read(store, &id).unwrap()
        else {
            panic!("new pack must supply current native bytes");
        };
        assert_eq!(current, body);
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_spawn"], 2);
        assert_eq!(counts["packed_reap"], 1);
        assert_eq!(counts["packed_query"], 2);
        drop(decoders);
        assert_eq!(
            snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts["packed_reap"]),
            2
        );
    }

    #[test]
    fn packed_decoder_requalifies_native_context_even_when_ordered_store_is_shared() {
        let fixture = reuse_fixture(true);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let stores = std::slice::from_ref(&fixture.store);
        let mut decoders = SnapshotPackedDecoders::default();
        for native in ["absent-native-one", "absent-native-two"] {
            let bucket = fixture.dir.path().join(native);
            assert_eq!(
                qualified_snapshot_stores(&bucket, &fixture.store).unwrap(),
                stores
            );
            decoders.qualify(&bucket, &fixture.store, stores).unwrap();
            let Some(SnapshotObjectSource::Packed { body, .. }) =
                decoders.read(stores, &fixture.blob).unwrap()
            else {
                panic!("each current context must independently query native bytes");
            };
            assert_eq!(body, b"synthetic overlapping saved blob");
        }
        decoders.finish().unwrap();
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_spawn"], 2);
        assert_eq!(counts["packed_query"], 2);
        assert_eq!(counts["packed_validate"], 2);
        assert_eq!(counts["packed_reap"], 2);
    }

    #[test]
    fn complete_export_replaced_pack_cannot_supply_retired_descriptor_bytes() {
        let fixture = reuse_fixture(true);
        let replacement = reuse_fixture(true);
        let git_dir = replacement.store.parent().unwrap();
        let different = fixture_git(
            git_dir,
            &["hash-object", "-w", "--stdin"],
            Some(b"unrelated replacement packed bytes"),
        );
        for index in 0..2 {
            fixture_git(
                git_dir,
                &["update-ref", "-d", &format!("refs/fixture/{index}")],
                None,
            );
        }
        fixture_git(
            git_dir,
            &["update-ref", "refs/fixture/new", &different],
            None,
        );
        fixture_git(git_dir, &["repack", "-a", "-d"], None);
        let replacement_files = fs::read_dir(replacement.store.join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        let originals = fs::read_dir(fixture.store.join("pack"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        let packed_dir = fixture.store.join("pack");
        let exported = export_after_warm_mutation(&fixture, move |count| {
            if count != 2 {
                return;
            }
            // Replace the exact names: a decoder retaining old descriptors
            // would resurrect both original root trees despite this new pack.
            for path in &originals {
                let source = replacement_files
                    .iter()
                    .find(|source| source.extension() == path.extension())
                    .unwrap();
                fs::remove_file(path).unwrap();
                fs::copy(source, path).unwrap();
            }
            assert_eq!(fs::read_dir(&packed_dir).unwrap().count(), originals.len());
        })
        .unwrap();
        assert!(exported
            .manifest()
            .saved_snapshots
            .iter()
            .all(|reference| reference.availability
                == SavedSnapshotAvailability::UnavailableInQualifiedLocations));
        let counts = snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
        assert_eq!(counts["packed_spawn"], 2);
        assert_eq!(counts["packed_reap"], 2);
        assert_eq!(
            counts["packed_query"], 12,
            "warm closure and nine fresh unavailable root queries"
        );
    }

    #[test]
    fn complete_export_current_loose_overrides_warm_packed_decoder() {
        for wrong_identity in [false, true] {
            let fixture = reuse_fixture(true);
            let path = fixture_object_path(&fixture, &fixture.blob);
            let body = if wrong_identity {
                b"wrong current native content".as_slice()
            } else {
                b"synthetic overlapping saved blob".as_slice()
            };
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
            write!(encoder, "blob {}\0", body.len()).unwrap();
            encoder.write_all(body).unwrap();
            let current = encoder.finish().unwrap();
            let sha = digest(&current);
            let result = export_after_warm_mutation(&fixture, move |count| {
                if count == 2 {
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(&path, &current).unwrap();
                }
            });
            if wrong_identity {
                assert!(
                    matches!(result, Err(TransferError::Blocked(ref reason)) if reason.contains("content identity"))
                );
                assert_eq!(
                    fs::read_dir(fixture.dir.path().join("extract"))
                        .unwrap()
                        .count(),
                    0
                );
            } else {
                let export = result.unwrap();
                for reference in &export.manifest().saved_snapshots {
                    assert_eq!(
                        reference
                            .objects
                            .iter()
                            .find(|object| object.object_id == fixture.blob)
                            .unwrap()
                            .compressed_sha256,
                        sha
                    );
                }
                let (ordinary, _, _) = reuse_export(&fixture, Some(0));
                assert_eq!(
                    fs::read(&export.payload_path).unwrap(),
                    fs::read(&ordinary.payload_path).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(export.manifest()).unwrap(),
                    serde_json::to_value(ordinary.manifest()).unwrap()
                );
            }
        }
    }

    #[test]
    fn complete_export_warm_packed_alternate_changes_requalify_current_storage() {
        for outside in [false, true] {
            let fixture = reuse_fixture(true);
            let workspace = fixture.dir.path().join("workspace");
            let alternate = if outside {
                fixture.dir.path().join("unqualified/objects")
            } else {
                workspace.join(".git/alternate")
            };
            fs::create_dir_all(&alternate).unwrap();
            let info = fixture.store.join("info");
            let exported = export_after_warm_mutation(&fixture, move |count| {
                if count == 2 {
                    fs::write(
                        info.join("alternates"),
                        format!("{}\n", alternate.display()),
                    )
                    .unwrap();
                }
            });
            if outside {
                assert!(
                    matches!(exported, Err(TransferError::Blocked(ref reason)) if reason.contains("outside"))
                );
                assert_eq!(
                    fs::read_dir(fixture.dir.path().join("extract"))
                        .unwrap()
                        .count(),
                    0
                );
            } else {
                let exported = exported.unwrap();
                assert!(exported
                    .manifest()
                    .saved_snapshots
                    .iter()
                    .all(|reference| reference.availability
                        == SavedSnapshotAvailability::RetainedClosure));
                let counts =
                    snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts.clone());
                assert_eq!(counts["packed_spawn"], 2);
                assert_eq!(counts["packed_reap"], 2);
                assert_eq!(counts["packed_query"], 30);
                assert_eq!(counts["packed_validate"], 30);
            }
        }
    }

    #[test]
    fn warm_loose_encoding_is_distinct_from_current_packed_default_encoding() {
        let fixture = reuse_fixture(true);
        let blob_path = fixture_object_path(&fixture, &fixture.blob);
        let packed = read_snapshot_object(std::slice::from_ref(&fixture.store), &fixture.blob)
            .unwrap()
            .unwrap();
        let (_, body) = decode_snapshot_object(&fixture.blob, &packed).unwrap();
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
        write!(encoder, "blob {}\0", body.len()).unwrap();
        encoder.write_all(&body).unwrap();
        let loose = encoder.finish().unwrap();
        assert_ne!(loose, packed);
        fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        fs::write(&blob_path, &loose).unwrap();
        let warmed = export_after_warm_mutation(&fixture, move |count| {
            if count == 2 {
                fs::remove_file(&blob_path).unwrap();
            }
        })
        .unwrap();
        let (plain, _, _) = reuse_export(&fixture, Some(0));
        assert_eq!(
            fs::read(&warmed.payload_path).unwrap(),
            fs::read(&plain.payload_path).unwrap()
        );
        assert_eq!(
            serde_json::to_value(warmed.manifest()).unwrap(),
            serde_json::to_value(plain.manifest()).unwrap()
        );
        for reference in &warmed.manifest().saved_snapshots {
            let blob = reference
                .objects
                .iter()
                .find(|object| object.object_id == fixture.blob)
                .unwrap();
            assert_eq!(blob.compressed_sha256, digest(&packed));
            assert_ne!(blob.compressed_sha256, digest(&loose));
        }
    }

    #[cfg(unix)]
    #[test]
    fn complete_export_warm_unreadable_child_refuses_then_restores_fixture_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = reuse_fixture(false);
        let path = fixture_object_path(&fixture, &fixture.blob);
        let callback_path = path.clone();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let result = export_after_warm_mutation(&fixture, move |count| {
            if count == 2 {
                fs::set_permissions(&callback_path, fs::Permissions::from_mode(0o0)).unwrap();
            }
        });
        fs::set_permissions(&path, original_permissions).unwrap();
        assert!(
            matches!(result, Err(TransferError::Io(_))),
            "{:?}",
            result.as_ref().err()
        );
        assert_eq!(
            fs::read_dir(fixture.dir.path().join("extract"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn warm_resolver_rechecks_another_workspace_and_emits_distinct_native_buckets() {
        let fixture = reuse_fixture(false);
        let first_workspace = fixture.dir.path().join("workspace");
        let second_workspace = fixture.dir.path().join("second-workspace");
        fs::create_dir(&second_workspace).unwrap();
        let first_worktree = hex::encode(sha1::Sha1::digest(
            first_workspace.to_string_lossy().as_bytes(),
        ));
        let second_worktree = hex::encode(sha1::Sha1::digest(
            second_workspace.to_string_lossy().as_bytes(),
        ));
        let mounts = HashMap::from([
            (
                "ses_exact".to_string(),
                ResolvedWorkspaceMount {
                    canonical_root: first_workspace,
                    identity: WorkspaceIdentity {
                        project_id: "prj".into(),
                        workspace_id: None,
                        directory: "/synthetic".into(),
                    },
                },
            ),
            (
                "ses_other".to_string(),
                ResolvedWorkspaceMount {
                    canonical_root: second_workspace,
                    identity: WorkspaceIdentity {
                        project_id: "prj_other".into(),
                        workspace_id: None,
                        directory: "/synthetic/other".into(),
                    },
                },
            ),
        ]);
        snapshot_reuse_test_hooks::STATE.with(|state| *state.borrow_mut() = Default::default());
        let data_home = fixture.inventory.default_database.parent().unwrap();
        let mut resolver = AssetResolver::new(data_home.join("tool-output"), &mounts);
        resolver.snapshot_data_home = Some(data_home.to_path_buf());
        resolver.snapshot_projects = HashMap::from([
            ("ses_exact".into(), "prj".into()),
            ("ses_other".into(), "prj_other".into()),
        ]);
        resolver
            .record_saved_snapshot(&fixture.trees[0], "ses_exact")
            .unwrap();
        resolver
            .record_saved_snapshot(&fixture.trees[0], "ses_other")
            .unwrap();
        assert_eq!(
            resolver.saved_snapshots[&("ses_other".into(), fixture.trees[0].clone())].availability,
            SavedSnapshotAvailability::UnavailableInQualifiedLocations
        );
        let second_store = data_home
            .join("snapshot/prj_other")
            .join(&second_worktree)
            .join("objects");
        for object in
            &resolver.saved_snapshots[&("ses_exact".into(), fixture.trees[0].clone())].objects
        {
            let target = second_store
                .join(&object.object_id[..2])
                .join(&object.object_id[2..]);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::copy(fixture_object_path(&fixture, &object.object_id), target).unwrap();
        }
        resolver
            .record_saved_snapshot(&fixture.trees[0], "ses_other")
            .unwrap();
        assert_eq!(resolver.snapshot_objects.len(), 6);
        assert_eq!(
            snapshot_reuse_test_hooks::STATE.with(|state| state.borrow().counts["hex"]),
            3
        );
        for object in
            &resolver.saved_snapshots[&("ses_exact".into(), fixture.trees[0].clone())].objects
        {
            let first = &resolver.snapshot_objects[&(
                "prj".into(),
                first_worktree.clone(),
                object.object_id.clone(),
            )];
            let second = &resolver.snapshot_objects[&(
                "prj_other".into(),
                second_worktree.clone(),
                object.object_id.clone(),
            )];
            assert!(
                Arc::ptr_eq(&first.compressed_hex, &second.compressed_hex),
                "destination tuples share emitted bytes without another hex allocation"
            );
        }
        let destination = fixture.dir.path().join("destination/opencode.db");
        let rows = vec![SerializedRow {
            table: "session".into(),
            key: vec![SerializedSqlValue::Text {
                value: "ses_exact".into(),
            }],
            values: BTreeMap::from([
                (
                    "id".into(),
                    SerializedSqlValue::Text {
                        value: "ses_exact".into(),
                    },
                ),
                (
                    "project_id".into(),
                    SerializedSqlValue::Text {
                        value: "prj".into(),
                    },
                ),
                ("workspace_id".into(), SerializedSqlValue::Null),
                (
                    "directory".into(),
                    SerializedSqlValue::Text {
                        value: fixture
                            .dir
                            .path()
                            .join("workspace")
                            .to_string_lossy()
                            .into_owned(),
                    },
                ),
            ]),
        }];
        let references =
            vec![resolver.saved_snapshots[&("ses_exact".into(), fixture.trees[0].clone())].clone()];
        for ((project_id, worktree_sha1, object_id), output) in &resolver.snapshot_objects {
            if project_id != "prj" {
                continue;
            }
            install_snapshot_object(
                &SerializedSnapshotObject {
                    project_id: project_id.clone(),
                    worktree_sha1: worktree_sha1.clone(),
                    object_id: object_id.clone(),
                    compressed_hex: output.compressed_hex.as_ref().clone(),
                },
                &references,
                &destination,
            )
            .unwrap();
        }
        verify_saved_snapshot_references(
            &references,
            &rows,
            &destination,
            &fixture.dir.path().join("workspace"),
        )
        .unwrap();
        let removed = references[0]
            .objects
            .iter()
            .find(|object| object.object_id == fixture.blob)
            .unwrap();
        fs::remove_file(
            destination
                .parent()
                .unwrap()
                .join("snapshot/prj")
                .join(&first_worktree)
                .join("objects")
                .join(&removed.object_id[..2])
                .join(&removed.object_id[2..]),
        )
        .unwrap();
        assert!(
            matches!(
                verify_saved_snapshot_references(
                    &references,
                    &rows,
                    &destination,
                    &fixture.dir.path().join("workspace")
                ),
                Err(TransferError::Blocked(_))
            ),
            "source memo cannot satisfy a changed destination closure"
        );
    }

    #[test]
    fn complete_export_small_budget_falls_back_without_changing_any_output() {
        for packed in [false, true] {
            let fixture = reuse_fixture(packed);
            let (plain, _, reads) = reuse_export(&fixture, Some(0));
            for budget in [1, 1400, 3000] {
                let (old, old_counts, old_reads) =
                    reuse_export_policy(&fixture, Some(budget), false);
                let (bounded, counts, bounded_reads) = reuse_export(&fixture, Some(budget));
                assert!(
                    old_counts["hex"] > 4,
                    "budget exhaustion must execute ordinary conversion fallback"
                );
                if budget == 1 {
                    assert_eq!(old_counts["hex"], 30);
                }
                assert_eq!(counts["hex"], if packed { 4 } else { old_counts["hex"] });
                assert_eq!(old_reads, bounded_reads);
                assert_eq!(
                    fs::read(&old.payload_path).unwrap(),
                    fs::read(&bounded.payload_path).unwrap()
                );
                assert_eq!(reads, bounded_reads);
                assert_eq!(
                    fs::read(&plain.payload_path).unwrap(),
                    fs::read(&bounded.payload_path).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(plain.manifest()).unwrap(),
                    serde_json::to_value(bounded.manifest()).unwrap()
                );
            }
        }
    }

    #[test]
    fn capture_reports_live_phase_progress_and_safe_failure_without_changing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.db");
        let db = source(&path);
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_exact','slug','prj','/synthetic','private-body-marker','1',1,1)", []).unwrap();
        drop(db);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let snapshot_file = dir.path().join("snapshot.db");
        let observed_file = snapshot_file.clone();
        let options =
            ExportOptions::new(dir.path().join("extract")).with_progress_observer(move |event| {
                if event.phase == "backup" && event.state == "progress" {
                    assert!(
                        observed_file.exists(),
                        "progress comes from the actual backup"
                    );
                    let prior = observed.lock().unwrap();
                    assert!(
                        !prior
                            .iter()
                            .any(|event: &SourceTransferProgress| event.phase == "backup"
                                && event.state == "completed"),
                        "progress must arrive before backup returns"
                    );
                }
                observed.lock().unwrap().push(event);
            });
        let qualified = capture_qualified_snapshot(
            &HostOpenCodeInventory::new(path.clone()),
            &["ses_exact".into()],
            &snapshot_file,
            options.clone(),
        )
        .unwrap();
        let observed_export =
            export_exact_session(&qualified.inventory(), "ses_exact", options.clone()).unwrap();
        let plain_export = export_exact_session(
            &qualified.inventory(),
            "ses_exact",
            ExportOptions::new(dir.path().join("extract")),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_vec(observed_export.manifest()).unwrap(),
            serde_json::to_vec(plain_export.manifest()).unwrap()
        );
        assert_eq!(
            fs::read(&observed_export.payload_path).unwrap(),
            fs::read(&plain_export.payload_path).unwrap()
        );
        let captured = events.lock().unwrap().clone();
        for phase in [
            "capture",
            "backup",
            "schema",
            "hash",
            "root_export",
            "saved_objects",
            "serialize",
        ] {
            let lifecycle = captured
                .iter()
                .filter(|event| event.phase == phase)
                .collect::<Vec<_>>();
            assert!(!lifecycle.is_empty(), "missing phase {phase}");
            assert_eq!(lifecycle.first().unwrap().state, "started");
            assert_eq!(lifecycle.last().unwrap().state, "completed");
            assert!(lifecycle
                .iter()
                .all(|event| event.severity == "info" && event.error_class.is_none()));
        }
        for phase in ["backup", "hash"] {
            assert!(
                captured.iter().any(|event| event.phase == phase
                    && event.state == "progress"
                    && event.completed_count > 0),
                "missing actual live progress for {phase}"
            );
        }
        events.lock().unwrap().clear();
        let changed = Connection::open(&path).unwrap();
        changed
            .execute_batch("CREATE TABLE private_body_marker(secret TEXT)")
            .unwrap();
        drop(changed);
        let failure = capture_qualified_snapshot(
            &HostOpenCodeInventory::new(path),
            &["ses_exact".into()],
            &dir.path().join("bad.db"),
            options,
        );
        assert!(matches!(failure, Err(TransferError::Blocked(_))));
        let failed = events.lock().unwrap();
        for phase in ["schema", "capture"] {
            assert!(failed.iter().any(|event| event.phase == phase
                && event.state == "failed"
                && event.severity == "error"
                && event.error_class == Some("blocked")));
        }
        assert!(!serde_json::to_string(&*failed)
            .unwrap()
            .contains("private_body_marker"));
    }

    fn qualified_fixture(dir: &Path) -> QualifiedSourceSnapshot {
        let path = dir.join("source.db");
        let db = source(&path);
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_exact','slug','prj','/synthetic','synthetic','1',1,1)", []).unwrap();
        drop(db);
        capture_qualified_snapshot(
            &HostOpenCodeInventory::new(path),
            &["ses_exact".into()],
            &dir.join("snapshot.db"),
            ExportOptions::new(dir.join("extract")),
        )
        .unwrap()
    }

    #[test]
    fn qualified_wal_capture_exports_all_seven_roots_without_reader_identity_drift() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.db");
        let db = source(&path);
        db.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        let roots = (0..7)
            .map(|index| format!("ses_root_{index}"))
            .collect::<Vec<_>>();
        for root in &roots {
            db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES (?1,'slug','prj','/synthetic','synthetic','1',1,1)", [root]).unwrap();
        }
        let original_hash = hash_file(&path).unwrap();
        let options = ExportOptions::new(dir.path().join("extract"));
        let qualified = capture_qualified_batch(
            &HostOpenCodeInventory::new(path.clone()),
            &roots,
            options.clone(),
        )
        .unwrap();
        for root in &roots {
            let exported =
                export_exact_session(&qualified.inventory(), root, options.clone()).unwrap();
            assert_eq!(
                source_graph_fingerprint(exported.manifest()).unwrap(),
                qualified
                    .receipt
                    .roots
                    .iter()
                    .find(|captured| &captured.root_session_id == root)
                    .unwrap()
                    .graph_fingerprint
            );
        }
        assert_eq!(hash_file(&path).unwrap(), original_hash);
        assert_eq!(
            db.query_row("SELECT count(*) FROM session", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    fn assert_qualified_refusal(qualified: &QualifiedSourceSnapshot, dir: &Path, reason: &str) {
        let result = export_exact_session(
            &qualified.inventory(),
            "ses_exact",
            ExportOptions::new(dir.join("extract")),
        );
        let error = result
            .err()
            .expect("changed qualified snapshot must refuse export");
        assert!(
            matches!(error, TransferError::Blocked(ref actual) if actual == reason),
            "{error:?}"
        );
    }

    #[test]
    fn qualified_snapshot_guard_classifies_size_and_selected_root_drift() {
        let dir = tempfile::tempdir().unwrap();
        let qualified = qualified_fixture(dir.path());
        let mut wrong_size = qualified.clone();
        wrong_size.receipt.snapshot_bytes += 1;
        assert_qualified_refusal(&wrong_size, dir.path(), "qualified snapshot changed: bytes");
        let mut wrong_root = qualified.clone();
        wrong_root.receipt.roots.clear();
        assert_qualified_refusal(
            &wrong_root,
            dir.path(),
            "qualified snapshot changed: selected_root",
        );
        let mut wrong_path = qualified.clone();
        wrong_path.path = dir.path().join("extract").join("..").join("snapshot.db");
        assert_qualified_refusal(&wrong_path, dir.path(), "qualified snapshot changed: path");
    }

    #[test]
    fn qualified_snapshot_guard_classifies_actual_sidecar_presence() {
        for (suffix, reason) in [
            ("-wal", "qualified snapshot changed: wal_presence"),
            ("-journal", "qualified snapshot changed: journal_presence"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let qualified = qualified_fixture(dir.path());
            let sidecar = PathBuf::from(format!("{}{suffix}", qualified.path.display()));
            fs::write(sidecar, []).unwrap();
            assert_qualified_refusal(&qualified, dir.path(), reason);
        }
    }

    #[test]
    fn qualified_snapshot_guard_still_refuses_actual_database_writes_and_growth() {
        let dir = tempfile::tempdir().unwrap();
        let qualified = qualified_fixture(dir.path());
        let writer = Connection::open(&qualified.path).unwrap();
        writer
            .execute(
                "UPDATE session SET title='changed' WHERE id='ses_exact'",
                [],
            )
            .unwrap();
        drop(writer);
        let error = export_exact_session(
            &qualified.inventory(),
            "ses_exact",
            ExportOptions::new(dir.path().join("extract")),
        )
        .err()
        .expect("native content writes must refuse qualified export");
        assert!(
            matches!(error, TransferError::Blocked(ref reason) if reason.starts_with("qualified snapshot changed: database_")),
            "{error:?}"
        );

        let dir = tempfile::tempdir().unwrap();
        let qualified = qualified_fixture(dir.path());
        OpenOptions::new()
            .append(true)
            .open(&qualified.path)
            .unwrap()
            .write_all(&[0; 4096])
            .unwrap();
        assert_qualified_refusal(&qualified, dir.path(), "qualified snapshot changed: bytes");
    }

    #[cfg(unix)]
    #[test]
    fn qualified_snapshot_guard_classifies_actual_mode_and_file_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let qualified = qualified_fixture(dir.path());
        fs::set_permissions(&qualified.path, fs::Permissions::from_mode(0o400)).unwrap();
        assert_qualified_refusal(
            &qualified,
            dir.path(),
            "qualified snapshot changed: database_mode",
        );
        fs::set_permissions(&qualified.path, fs::Permissions::from_mode(0o600)).unwrap();
        let error = export_exact_session(
            &qualified.inventory(),
            "ses_exact",
            ExportOptions::new(dir.path().join("extract")),
        )
        .err()
        .expect("restored mode must retain changed ctime fence");
        assert!(
            matches!(error, TransferError::Blocked(ref reason) if reason == "qualified snapshot changed: database_ctime" || reason == "qualified snapshot changed: database_ctime_nsec")
        );
        let mut qualified = qualified;
        qualified.files = SnapshotFiles::read(&qualified.path).unwrap();
        let replacement = dir.path().join("replacement.db");
        fs::copy(&qualified.path, &replacement).unwrap();
        fs::rename(&replacement, &qualified.path).unwrap();
        assert_qualified_refusal(
            &qualified,
            dir.path(),
            "qualified snapshot changed: database_inode",
        );
    }

    fn source(path: &Path) -> Connection {
        let db = Connection::open(path).unwrap();
        db.execute_batch(PINNED_SCHEMA_SQL).unwrap();
        for (index, migration) in PINNED_MIGRATIONS.iter().enumerate() {
            db.execute(
                "INSERT INTO migration(id,time_completed) VALUES (?1,?2)",
                rusqlite::params![migration, index as i64],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn native_inventory_proves_complete_absence_and_detects_available_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let db = source(&path);
        let store = digest(path.canonicalize().unwrap().to_string_lossy().as_bytes());
        let inventory = HostOpenCodeInventory::new(path);
        let absent = inventory.inspect_exact_origin(&store, "ses_exact").unwrap();
        assert!(!absent.available());
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_exact','slug','prj','/synthetic','synthetic','1',1,1)", []).unwrap();
        assert!(inventory
            .inspect_exact_origin(&store, "ses_exact")
            .unwrap()
            .available());
    }

    #[test]
    fn native_inventory_does_not_certify_remaining_history_without_its_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let db = source(&path);
        let store = digest(path.canonicalize().unwrap().to_string_lossy().as_bytes());
        db.execute(
            "INSERT INTO event_sequence(aggregate_id,seq) VALUES ('ses_exact',1)",
            [],
        )
        .unwrap();
        assert!(
            HostOpenCodeInventory::new(path)
                .inspect_exact_origin(&store, "ses_exact")
                .is_err(),
            "remaining native history must keep absence unresolved"
        );
    }

    #[test]
    fn native_inventory_never_certifies_missing_broken_or_partial_inventory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let _db = source(&path);
        let store = digest(path.canonicalize().unwrap().to_string_lossy().as_bytes());
        let missing = dir.path().join("missing.db");
        assert!(HostOpenCodeInventory::new(missing.clone())
            .inspect_exact_origin(&store, "ses_exact")
            .is_err());
        assert!(HostOpenCodeInventory::new(path.clone())
            .with_channel_database(path.clone())
            .with_channel_database(missing.clone())
            .inspect_exact_origin(&store, "ses_exact")
            .is_err());
        let other = dir.path().join("opencode-channel.db");
        let _other = source(&other);
        assert!(HostOpenCodeInventory::new(path.clone())
            .with_channel_database(other)
            .inspect_exact_origin(&store, "ses_exact")
            .is_err());
        #[cfg(unix)]
        {
            let broken = dir.path().join("broken.db");
            std::os::unix::fs::symlink(missing, &broken).unwrap();
            assert!(HostOpenCodeInventory::new(broken)
                .inspect_exact_origin(&store, "ses_exact")
                .is_err());
        }
        let corrupt = dir.path().join("corrupt.db");
        fs::write(&corrupt, b"not sqlite").unwrap();
        assert!(HostOpenCodeInventory::new(path.clone())
            .with_channel_database(path)
            .with_channel_database(corrupt)
            .inspect_exact_origin(&store, "ses_exact")
            .is_err());
    }
}
