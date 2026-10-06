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
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

use crate::provider_layout::ProviderLayout;

const EXPORT_VERSION: u32 = 1;
const OPENCODE_SCHEMA_VERSION: &str = "opencode-1.18.21";
const PINNED_SCHEMA_SQL: &str = include_str!("opencode_schema_v1_18_21.sql");
const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
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
    receipt: QualifiedSnapshotReceipt,
    tool_output_directory: PathBuf,
    workspace_mounts: Vec<WorkspaceMountMapping>,
    trusted_directory_mounts: Vec<PathBuf>,
    _capture_guard: Option<std::sync::Arc<TempDir>>,
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
    let source_path = resolve_exact_source(inventory, &roots[0])?.canonicalize()?;
    for root in roots {
        if resolve_exact_source(inventory, root)?.canonicalize()? != source_path {
            return Err(TransferError::Blocked(
                "selected roots do not share one independently resolved source".into(),
            ));
        }
    }
    let source = open_source_read_only(&source_path)?;
    let mut private = OpenOptions::new();
    private.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        private.mode(0o600);
    }
    private.open(snapshot_file)?.sync_all()?;
    create_online_backup(&source, snapshot_file)?;
    let snapshot = Connection::open_with_flags(
        snapshot_file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    validate_known_schema(&snapshot)?;
    let bytes = fs::metadata(snapshot_file)?.len();
    let mut qualified = QualifiedSourceSnapshot {
        path: snapshot_file.canonicalize()?,
        receipt: QualifiedSnapshotReceipt {
            source_store_id: digest(source_path.to_string_lossy().as_bytes()),
            canonical_source_database: source_path.clone(),
            snapshot_sha256: hash_file(snapshot_file)?,
            snapshot_bytes: bytes,
            source_schema_fingerprint: schema_fingerprint(&snapshot)?,
            migration_journal_fingerprint: migration_fingerprint(&snapshot)?,
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
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
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

#[derive(Debug, Clone)]
pub struct ExportOptions {
    extraction_root: PathBuf,
}

impl ExportOptions {
    pub fn new(extraction_root: PathBuf) -> Self {
        Self { extraction_root }
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
    pub rows: Vec<RowDigest>,
    pub assets: Vec<SerializedAssetMetadata>,
    /// Body-free native ordering and saved boundary evidence. Older manifests
    /// omit it and cannot authorize removal of imported messages or parts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub native_cleanup_baselines: Vec<NativeCleanupBaseline>,
    /// Exact saved references remain history even when their undo object is
    /// unavailable in the qualified retained stores.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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

fn capture_native_cleanup_baselines(
    rows: &[SerializedRow],
) -> Result<Vec<NativeCleanupBaseline>, TransferError> {
    let mut parts = HashMap::<String, Vec<String>>::new();
    for row in rows.iter().filter(|row| row.table == "part") {
        parts
            .entry(required_text(row, "message_id")?)
            .or_default()
            .push(required_text(row, "id")?);
    }
    for ids in parts.values_mut() {
        ids.sort();
    }
    let mut messages = HashMap::<String, Vec<NativeMessageBaseline>>::new();
    for row in rows.iter().filter(|row| row.table == "message") {
        let message_id = required_text(row, "id")?;
        messages
            .entry(required_text(row, "session_id")?)
            .or_default()
            .push(NativeMessageBaseline {
                part_ids: parts.remove(&message_id).unwrap_or_default(),
                message_id,
                time_created: row.values.get("time_created").cloned().ok_or_else(|| {
                    TransferError::Blocked("native message ordering is missing".into())
                })?,
            });
    }
    for selected in messages.values_mut() {
        selected.sort_by(|left, right| left.message_id.cmp(&right.message_id));
    }
    let mut baselines = rows
        .iter()
        .filter(|row| row.table == "session")
        .map(|session| {
            let session_id = required_text(session, "id")?;
            let revert = value_text(session, "revert")?
                .map(|raw| serde_json::from_str::<serde_json::Value>(&raw))
                .transpose()
                .map_err(|_| TransferError::Blocked("saved native revert is malformed".into()))?
                .and_then(|value| {
                    value
                        .get("messageID")
                        .and_then(serde_json::Value::as_str)
                        .map(|message_id| NativeRevertBoundary {
                            message_id: message_id.into(),
                            part_id: value
                                .get("partID")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string),
                        })
                });
            let selected_messages = messages.remove(&session_id).unwrap_or_default();
            Ok(NativeCleanupBaseline {
                session_id,
                revert,
                messages: selected_messages,
            })
        })
        .collect::<Result<Vec<_>, TransferError>>()?;
    baselines.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    Ok(baselines)
}

pub fn verify_native_cleanup_baselines(
    expected: &[NativeCleanupBaseline],
    rows: &[SerializedRow],
) -> Result<(), TransferError> {
    if !expected.is_empty() && capture_native_cleanup_baselines(rows)? != expected {
        return Err(TransferError::Blocked(
            "native cleanup baseline differs from the complete installed rows".into(),
        ));
    }
    Ok(())
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
    if root_session_id.is_empty() || root_session_id.len() > 256 {
        return Err(TransferError::Blocked(
            "native session ID is empty or over its bound".into(),
        ));
    }

    let source_path = resolve_exact_source(inventory, root_session_id)?;
    if let Some(qualified) = &inventory.qualified_snapshot {
        if source_path.canonicalize()? != qualified.path
            || fs::metadata(&qualified.path)?.len() != qualified.receipt.snapshot_bytes
            || hash_file(&qualified.path)? != qualified.receipt.snapshot_sha256
            || !qualified
                .receipt
                .roots
                .iter()
                .any(|root| root.root_session_id == root_session_id)
        {
            return Err(TransferError::Blocked(
                "qualified snapshot bytes, selected root or source binding changed".into(),
            ));
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
        create_online_backup(&source, &snapshot_path)?;
    }
    if let Some(qualified) = &inventory.qualified_snapshot {
        if hash_file(&qualified.path)? != qualified.receipt.snapshot_sha256 {
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
        validate_known_schema(&snapshot)?;
        let source_schema_fingerprint = schema_fingerprint(&snapshot)?;
        let migration_journal_fingerprint = migration_fingerprint(&snapshot)?;
        let sqlite_version = snapshot.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let mut rows = collect_exact_closure(&snapshot, root_session_id)?;
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
        asset_resolver.resolve_rows(&mut rows)?;
        let assets = asset_resolver.metadata();
        let saved_snapshots = asset_resolver
            .saved_snapshots
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let snapshot_objects = asset_resolver
            .snapshot_objects
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let native_cleanup_baselines = capture_native_cleanup_baselines(&rows)?;
        let payload_path = extraction.path().join("bundle.json");
        let mut row_digests = Vec::with_capacity(rows.len());
        let (payload_bytes, payload_sha256) = {
            let file = File::create(&payload_path)?;
            let mut hasher = Sha256::new();
            let mut writer = HashingWriter::new(file, &mut hasher, MAX_BUNDLE_BYTES);
            let serialized = serde_json::to_writer(
                &mut writer,
                &TransferPayload {
                    version: EXPORT_VERSION,
                    root_session_id,
                    rows: &rows,
                    assets: &assets,
                    snapshot_objects: &snapshot_objects,
                },
            );
            if writer.limit_exceeded {
                return Err(TransferError::Blocked(
                    "exact-session bundle exceeds 8 GiB".into(),
                ));
            }
            serialized.map_err(|error| TransferError::Serialization(error.to_string()))?;
            writer.flush()?;
            let payload_bytes = writer.bytes;
            drop(writer);
            (payload_bytes, hex::encode(hasher.finalize()))
        };
        for row in &rows {
            row_digests.push(RowDigest {
                table: row.table.clone(),
                key: row.key.clone(),
                sha256: digest_serializable(row)?,
                column_sha256: serialized_column_digests(row)?,
                json_node_sha256: serialized_json_node_digests(row)?,
                transition_cursor: match row.table.as_str() {
                    "event_sequence" => value_integer(row, "seq")?,
                    "project" => value_integer(row, "time_updated")?,
                    _ => None,
                },
            });
        }
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
            row_count: row_digests.len(),
            rows: row_digests,
            assets,
            native_cleanup_baselines,
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
        if hash_file(&qualified.path)? != qualified.receipt.snapshot_sha256 {
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
    snapshot_objects: &'a [SerializedSnapshotObject],
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
    snapshot_objects: BTreeMap<(String, String, String), SerializedSnapshotObject>,
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
        }
    }

    fn metadata(&self) -> Vec<SerializedAssetMetadata> {
        self.assets.values().cloned().collect()
    }

    fn resolve_rows(&mut self, rows: &mut [SerializedRow]) -> Result<(), TransferError> {
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
                        self.record_git_tree(tree, session_id)?;
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
            .is_none_or(|reference| {
                reference.availability != SavedSnapshotAvailability::RetainedClosure
            })
        {
            return Err(TransferError::Blocked(
                "native snapshot part lacks its complete retained tree closure".into(),
            ));
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
        let Ok(store) = inspect_git_tree(&mount.canonical_root, tree) else {
            return Ok(());
        };
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
        if tree.len() != 40 || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(TransferError::Blocked(
                "saved snapshot is not a SHA1 tree reference".into(),
            ));
        }
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
        let closure = read_snapshot_closure(&stores, tree)?;
        let mut objects = Vec::new();
        if let Some(closure) = closure {
            for (object_id, compressed) in closure {
                objects.push(SnapshotObjectMetadata {
                    object_id: object_id.clone(),
                    compressed_bytes: compressed.len() as u64,
                    compressed_sha256: digest(&compressed),
                });
                self.snapshot_objects.insert(
                    (project_id.clone(), worktree_sha1.clone(), object_id.clone()),
                    SerializedSnapshotObject {
                        project_id: project_id.clone(),
                        worktree_sha1: worktree_sha1.clone(),
                        object_id,
                        compressed_hex: hex::encode(compressed),
                    },
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
        match fs::symlink_metadata(&path) {
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
        if path.canonicalize()? != path {
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
                let alternate = alternate.canonicalize()?;
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

fn read_snapshot_object(
    stores: &[PathBuf],
    object_id: &str,
) -> Result<Option<Vec<u8>>, TransferError> {
    if object_id.len() != 40 || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(TransferError::Blocked(
            "snapshot closure has an invalid object ID".into(),
        ));
    }
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
            Ok(_) => return Ok(Some(fs::read(path)?)),
        }
    }
    // Packed objects use the native decoder only after storage confinement;
    // ordinary owned loose-object fixtures need no external CLI.
    for store in stores {
        let pack = store.join("pack");
        if pack.exists() && fs::read_dir(&pack)?.next().is_some() {
            let git_dir = store.parent().ok_or_else(|| {
                TransferError::Blocked("snapshot store lacks native Git directory".into())
            })?;
            inspect_git_pack_directory(git_dir, store)?;
            let repository = GitRepository {
                work_tree: git_dir.to_path_buf(),
                git_dir: git_dir.to_path_buf(),
            };
            let mut command = sanitized_git_command();
            command
                .arg("--git-dir")
                .arg(&repository.git_dir)
                .arg("--work-tree")
                .arg(&repository.work_tree)
                .arg("cat-file")
                .arg("--batch")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = command.spawn()?;
            child
                .stdin
                .take()
                .ok_or_else(|| {
                    TransferError::Blocked("packed snapshot decoder input is unavailable".into())
                })?
                .write_all(format!("{object_id}\n").as_bytes())?;
            let output = child.wait_with_output()?;
            if !output.status.success() {
                return Err(TransferError::Blocked(
                    "packed snapshot decoder failed".into(),
                ));
            }
            let Some((kind, body)) = decode_packed_snapshot_response(object_id, &output.stdout)?
            else {
                continue;
            };
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            write!(encoder, "{kind} {}\0", body.len())?;
            encoder.write_all(body)?;
            return Ok(Some(encoder.finish()?));
        }
    }
    Ok(None)
}

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
    let fields = header.split(' ').collect::<Vec<_>>();
    if fields.as_slice() == [object_id, "missing"] && output.len() == newline + 1 {
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
    if length as u64 > MAX_BUNDLE_BYTES
        || output.len().checked_sub(newline + 1) != length.checked_add(1)
        || output.last() != Some(&b'\n')
    {
        return Err(TransferError::Blocked(
            "packed snapshot decoder returned an incomplete or oversized object".into(),
        ));
    }
    Ok(Some((fields[1], &output[newline + 1..output.len() - 1])))
}

#[cfg(test)]
mod packed_snapshot_response_tests {
    use super::*;

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
        if !matches!(mode, "40000" | "040000" | "100644" | "100755" | "120000")
            || name.is_empty()
            || name == b"."
            || name == b".."
            || name.contains(&b'/')
            || nul + 21 > bytes.len()
        {
            return Err(TransferError::Blocked(
                "snapshot tree contains an unsupported entry".into(),
            ));
        }
        children.push((
            hex::encode(&bytes[nul + 1..nul + 21]),
            matches!(mode, "40000" | "040000"),
        ));
        cursor = nul + 21;
    }
    Ok(children)
}

fn read_snapshot_closure(
    stores: &[PathBuf],
    tree: &str,
) -> Result<Option<BTreeMap<String, Vec<u8>>>, TransferError> {
    let Some(root) = read_snapshot_object(stores, tree)? else {
        return Ok(None);
    };
    let mut pending = vec![(tree.to_string(), true, Some(root))];
    let mut closure = BTreeMap::new();
    let mut total = 0u64;
    while let Some((id, is_tree, known)) = pending.pop() {
        if closure.contains_key(&id) {
            continue;
        }
        let compressed = known
            .or(read_snapshot_object(stores, &id)?)
            .ok_or_else(|| {
                TransferError::Blocked("retained snapshot has an incomplete tree closure".into())
            })?;
        total = total
            .checked_add(compressed.len() as u64)
            .filter(|size| *size <= MAX_BUNDLE_BYTES / 2)
            .ok_or_else(|| {
                TransferError::Blocked("snapshot closure exceeds its encoded transfer bound".into())
            })?;
        let (kind, bytes) = decode_snapshot_object(&id, &compressed)?;
        if (kind == "tree") != is_tree {
            return Err(TransferError::Blocked(
                "snapshot closure object kind differs from its tree edge".into(),
            ));
        }
        if is_tree {
            for (id, is_tree) in snapshot_tree_children(&bytes)? {
                pending.push((id, is_tree, None));
            }
        }
        closure.insert(id, compressed);
    }
    Ok(Some(closure))
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

struct GitRepository {
    work_tree: PathBuf,
    git_dir: PathBuf,
}

fn inspect_git_tree(mount: &Path, tree: &str) -> Result<GitTreeInspection, TransferError> {
    if !(tree.len() == 40 || tree.len() == 64) || !tree.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(TransferError::Blocked(
            "snapshot reference is not a supported content-addressed Git object ID".into(),
        ));
    }
    let mount = fs::canonicalize(mount).map_err(|error| {
        TransferError::Blocked(format!("exact workspace mount is unavailable: {error}"))
    })?;
    let top_level = git_text_in_mount(&mount, &["rev-parse", "--show-toplevel"])?;
    let top_level = PathBuf::from(top_level.trim());
    let top_level = fs::canonicalize(top_level).map_err(|error| {
        TransferError::Blocked(format!("workspace Git root cannot be resolved: {error}"))
    })?;
    if top_level != mount {
        return Err(TransferError::Blocked(
            "snapshot Git root is not the exact managed workspace mount".into(),
        ));
    }
    let git_dir = git_path_in_mount(&mount, "--absolute-git-dir")?;
    if !git_dir.starts_with(&mount) {
        return Err(TransferError::Blocked(
            "snapshot Git directory is outside the exact managed workspace mount".into(),
        ));
    }
    let repository = GitRepository {
        work_tree: mount.clone(),
        git_dir,
    };
    let common_dir = git_path_in_repository(&repository, "--git-common-dir")?;
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
    if !repository.git_dir.starts_with(&mount) || !common_dir.starts_with(&mount) {
        return Err(TransferError::Blocked(
            "snapshot object store is outside the exact managed workspace mount".into(),
        ));
    }
    let object_format =
        git_text_in_repository(&repository, &["rev-parse", "--show-object-format"])?
            .trim()
            .to_string();
    let expected_id_length = match object_format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        _ => {
            return Err(TransferError::Blocked(
                "workspace uses an unsupported Git object format".into(),
            ))
        }
    };
    if tree.len() != expected_id_length {
        return Err(TransferError::Blocked(
            "snapshot object ID does not match the workspace Git format".into(),
        ));
    }
    let objects_dir =
        checked_git_store_directory(&mount, &common_dir.join("objects"), "Git object directory")?;
    let mut object_stores = vec![objects_dir.clone()];
    let mut alternate_identity = Vec::new();
    if let Some(contents) = read_alternates_file_in_store(&mount, &objects_dir)? {
        for line in contents.lines().filter(|line| !line.trim().is_empty()) {
            let candidate = PathBuf::from(line);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                objects_dir.join(candidate)
            };
            let candidate =
                checked_git_store_directory(&mount, &candidate, "alternate Git object store")?;
            if read_alternates_file_in_store(&mount, &candidate)?
                .is_some_and(|nested| nested.lines().any(|line| !line.trim().is_empty()))
            {
                return Err(TransferError::Blocked(
                    "nested Git object store alternates are unsupported".into(),
                ));
            }
            let relative = candidate.strip_prefix(&mount).map_err(|_| {
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
        inspect_git_pack_directory(&mount, object_store)?;
    }

    let mut objects = BTreeSet::new();
    let mut pending_trees = vec![tree.to_string()];
    let mut inspected_trees = BTreeSet::new();
    // Visit each tree separately so its storage paths are checked before Git
    // reads it; recursive `ls-tree` could open unchecked descendant trees.
    while let Some(current_tree) = pending_trees.pop() {
        if !inspected_trees.insert(current_tree.clone()) {
            continue;
        }
        verify_git_loose_object_paths(&mount, &object_stores, std::slice::from_ref(&current_tree))?;
        let object_kind = git_text_in_repository(&repository, &["cat-file", "-t", &current_tree])?;
        if object_kind.trim() != "tree" {
            return Err(TransferError::Blocked(
                "snapshot reference does not identify a Git tree object".into(),
            ));
        }
        objects.insert(current_tree.clone());
        let entries = git_output_in_repository(&repository, &["ls-tree", "-z", &current_tree])?;
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
            if fields.len() != 3 || fields[1] == "commit" {
                return Err(TransferError::Blocked(
                    "snapshot tree contains an unsupported submodule entry".into(),
                ));
            }
            let object = fields[2].to_string();
            if fields[1] == "tree" {
                pending_trees.push(object.clone());
            }
            objects.insert(object);
        }
    }
    let referenced_objects = objects.iter().cloned().collect::<Vec<_>>();
    verify_git_loose_object_paths(&mount, &object_stores, &referenced_objects)?;
    let mut object_records = Vec::with_capacity(objects.len());
    let mut closure_bytes = 0_u64;
    for object in objects {
        let object_kind = git_text_in_repository(&repository, &["cat-file", "-t", &object])?;
        let object_size = git_text_in_repository(&repository, &["cat-file", "-s", &object])?
            .trim()
            .parse::<u64>()
            .map_err(|_| TransferError::Blocked("Git object size is invalid".into()))?;
        closure_bytes = closure_bytes.saturating_add(object_size);
        object_records.push((object, object_kind.trim().to_string(), object_size));
    }
    let object_bytes = serde_json::to_vec(&object_records)
        .map_err(|error| TransferError::Serialization(error.to_string()))?;
    let common_relative = common_dir
        .strip_prefix(&mount)
        .map_err(|_| TransferError::Blocked("Git store escaped workspace mount".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    let identity = format!(
        "git:{object_format}:{common_relative}:{}:{tree}",
        alternate_identity.join(",")
    );
    Ok(GitTreeInspection {
        identity,
        closure_bytes,
        closure_sha256: digest(&object_bytes),
    })
}

fn read_alternates_file(path: &Path) -> Result<Option<String>, TransferError> {
    let metadata = match fs::symlink_metadata(path) {
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
    fs::read_to_string(path).map(Some).map_err(|error| {
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

fn checked_git_storage_path(
    mount: &Path,
    path: &Path,
    label: &str,
    expect_directory: bool,
) -> Result<Option<PathBuf>, TransferError> {
    let metadata = match fs::symlink_metadata(path) {
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
    let canonical = fs::canonicalize(path)
        .map_err(|error| TransferError::Blocked(format!("{label} cannot be resolved: {error}")))?;
    if !canonical.starts_with(mount) {
        return Err(TransferError::Blocked(format!(
            "{label} is outside the exact managed workspace mount"
        )));
    }
    let resolved_metadata = fs::metadata(&canonical)
        .map_err(|error| TransferError::Blocked(format!("{label} is unavailable: {error}")))?;
    let expected_type_matches = if expect_directory {
        resolved_metadata.is_dir()
    } else {
        resolved_metadata.is_file()
    };
    if !expected_type_matches {
        return Err(TransferError::Blocked(format!(
            "{label} is not a {}",
            if expect_directory {
                "directory"
            } else {
                "regular file"
            }
        )));
    }
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

fn git_path_in_mount(mount: &Path, argument: &str) -> Result<PathBuf, TransferError> {
    let path = PathBuf::from(git_text_in_mount(mount, &["rev-parse", argument])?.trim());
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
) -> Result<PathBuf, TransferError> {
    let path = PathBuf::from(git_text_in_repository(repository, &["rev-parse", argument])?.trim());
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

fn git_text_in_mount(mount: &Path, arguments: &[&str]) -> Result<String, TransferError> {
    let output = git_output_in_mount(mount, arguments)?;
    String::from_utf8(output.stdout)
        .map_err(|_| TransferError::Blocked("Git returned non-UTF-8 metadata".into()))
}

fn git_text_in_repository(
    repository: &GitRepository,
    arguments: &[&str],
) -> Result<String, TransferError> {
    let output = git_output_in_repository(repository, arguments)?;
    String::from_utf8(output.stdout)
        .map_err(|_| TransferError::Blocked("Git returned non-UTF-8 metadata".into()))
}

fn git_output_in_mount(mount: &Path, arguments: &[&str]) -> Result<Output, TransferError> {
    let mut command = sanitized_git_command();
    command.arg("-C").arg(mount).args(arguments);
    checked_git_output(command)
}

fn git_output_in_repository(
    repository: &GitRepository,
    arguments: &[&str],
) -> Result<Output, TransferError> {
    let mut command = sanitized_git_command();
    command
        .arg("--git-dir")
        .arg(&repository.git_dir)
        .arg("--work-tree")
        .arg(&repository.work_tree)
        .args(arguments);
    checked_git_output(command)
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

fn checked_git_output(mut command: Command) -> Result<Output, TransferError> {
    let output = command.output().map_err(|error| {
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

fn create_online_backup(source: &Connection, destination: &Path) -> Result<(), TransferError> {
    let mut target = Connection::open(destination)?;
    let backup = Backup::new(source, &mut target)?;
    backup
        .run_to_completion(128, Duration::from_millis(5), None)
        .map_err(|error| {
            TransferError::Blocked(format!("consistent SQLite snapshot failed: {error}"))
        })
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

fn value_integer(row: &SerializedRow, key: &str) -> Result<Option<i64>, TransferError> {
    match row.values.get(key) {
        Some(SerializedSqlValue::Integer { value }) => Ok(Some(*value)),
        Some(SerializedSqlValue::Null) | None => Ok(None),
        _ => Err(TransferError::Blocked(format!(
            "native row has an invalid {key} sequence"
        ))),
    }
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

fn serialized_column_digests(
    row: &SerializedRow,
) -> Result<BTreeMap<String, String>, TransferError> {
    row.values
        .iter()
        .map(|(name, value)| {
            let bytes = serde_json::to_vec(value)
                .map_err(|error| TransferError::Serialization(error.to_string()))?;
            Ok((name.clone(), digest(&bytes)))
        })
        .collect()
}

fn serialized_json_node_digests(
    row: &SerializedRow,
) -> Result<BTreeMap<String, String>, TransferError> {
    let mut digests = BTreeMap::new();
    for (column, value) in &row.values {
        let SerializedSqlValue::Text { value } = value else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(value) else {
            continue;
        };
        collect_json_node_digests(column, &json, "", &mut digests)?;
    }
    Ok(digests)
}

fn collect_json_node_digests(
    column: &str,
    value: &serde_json::Value,
    pointer: &str,
    digests: &mut BTreeMap<String, String>,
) -> Result<(), TransferError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| TransferError::Serialization(error.to_string()))?;
    digests.insert(format!("{column}#{pointer}"), digest(&bytes));
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                collect_json_node_digests(column, child, &format!("{pointer}/{escaped}"), digests)?;
            }
        }
        serde_json::Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                collect_json_node_digests(column, child, &format!("{pointer}/{index}"), digests)?;
            }
        }
        _ => {}
    }
    Ok(())
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
mod native_source_inventory_tests {
    use super::*;

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
