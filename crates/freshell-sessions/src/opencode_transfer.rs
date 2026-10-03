//! Exact-session OpenCode history export.
//!
//! The source is selected from trusted host inventory, opened read-only, and
//! copied through SQLite's Online Backup API into a private local extraction
//! directory. The backup is only an extraction intermediate: the returned
//! payload is a new JSON document containing the selected session closure,
//! never a copy of the host database.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::types::ValueRef;
use rusqlite::{params_from_iter, Connection, OpenFlags, Row};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

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
}

impl HostOpenCodeInventory {
    pub fn new(default_database: PathBuf) -> Self {
        Self {
            effective_database_override: None,
            working_directory: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            default_database,
            channel_databases: Vec::new(),
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

    pub fn with_channel_database(mut self, path: PathBuf) -> Self {
        self.channel_databases.push(path);
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

#[derive(Debug, Clone)]
pub struct ExportOptions {
    extraction_root: PathBuf,
    workspace_mount: Option<PathBuf>,
}

impl ExportOptions {
    pub fn new(extraction_root: PathBuf) -> Self {
        Self {
            extraction_root,
            workspace_mount: None,
        }
    }

    pub fn with_workspace_mount(mut self, workspace_mount: PathBuf) -> Self {
        self.workspace_mount = Some(workspace_mount);
        self
    }
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self::new(std::env::temp_dir().join("freshell-opencode-transfer"))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SerializedSqlValue {
    Null,
    Integer { value: i64 },
    Real { bits: String },
    Text { value: String },
    Blob { hex: String },
}

#[derive(Debug, Clone, Serialize)]
struct SerializedRow {
    table: String,
    key: Vec<SerializedSqlValue>,
    values: BTreeMap<String, SerializedSqlValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RowDigest {
    pub table: String,
    pub key: Vec<SerializedSqlValue>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeTransferManifest {
    pub version: u32,
    pub provider_schema: String,
    pub root_session_id: String,
    pub source_store_id: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub sqlite_version: String,
    pub row_count: usize,
    rows: Vec<RowDigest>,
    pub assets: Vec<SerializedAssetMetadata>,
    pub payload_bytes: u64,
    pub payload_sha256: String,
    pub generation: String,
}

impl OpenCodeTransferManifest {
    pub fn row_count(&self) -> usize {
        self.row_count
    }

    pub fn row_digests(&self) -> &[RowDigest] {
        &self.rows
    }
}

#[derive(Debug, Clone, Serialize)]
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
    let source = open_source_read_only(&source_path)?;
    let extraction_root = prepare_extraction_root(&options.extraction_root)?;
    recover_interrupted_extractions(&extraction_root)?;
    let extraction = Builder::new()
        .prefix(&format!("{EXTRACT_DIR_PREFIX}{}-", std::process::id()))
        .tempdir_in(&extraction_root)?;
    write_owner_pid(extraction.path())?;
    let snapshot_path = extraction.path().join("snapshot.sqlite");
    create_online_backup(&source, &snapshot_path)?;

    let result: Result<(PathBuf, OpenCodeTransferManifest), TransferError> = (|| {
        let snapshot = Connection::open_with_flags(
            &snapshot_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        snapshot.busy_timeout(Duration::from_secs(5))?;
        validate_known_schema(&snapshot)?;
        let source_schema_fingerprint = schema_fingerprint(&snapshot)?;
        let migration_journal_fingerprint = migration_fingerprint(&snapshot)?;
        let sqlite_version = snapshot.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
        let mut rows = collect_exact_closure(&snapshot, root_session_id)?;
        let mut asset_resolver = AssetResolver::new(
            inventory.tool_output_directory(&source_path),
            options.workspace_mount.as_deref(),
            extraction.path(),
        )?;
        asset_resolver.resolve_rows(&mut rows)?;
        let assets = asset_resolver.metadata();
        let asset_bytes = asset_resolver.copied_bytes;
        let payload_path = extraction.path().join("bundle.json");
        let mut row_digests = Vec::with_capacity(rows.len());
        let (payload_bytes, payload_sha256) = {
            let file = File::create(&payload_path)?;
            let mut hasher = Sha256::new();
            let mut writer = HashingWriter::new(
                file,
                &mut hasher,
                MAX_BUNDLE_BYTES.saturating_sub(asset_bytes),
            );
            let serialized = serde_json::to_writer(
                &mut writer,
                &TransferPayload {
                    version: EXPORT_VERSION,
                    root_session_id,
                    rows: &rows,
                    assets: &assets,
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
            });
        }
        let source_store_id = digest(source_path.canonicalize()?.to_string_lossy().as_bytes());
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
            payload_bytes,
            payload_sha256,
            generation: String::new(),
        };
        let manifest_bytes = serde_json::to_vec(&manifest)
            .map_err(|error| TransferError::Serialization(error.to_string()))?;
        manifest.generation = digest(&manifest_bytes);
        Ok((payload_path, manifest))
    })();

    // The backup and its SQLite sidecars are extraction-only. They are
    // removed before an export can be returned or published to another host.
    remove_snapshot_files(&snapshot_path)?;
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

struct AssetResolver<'a> {
    tool_output_root: PathBuf,
    workspace_mount: Option<&'a Path>,
    extraction_root: PathBuf,
    assets: BTreeMap<String, SerializedAssetMetadata>,
    tool_output_mappings: BTreeMap<PathBuf, String>,
    copied_bytes: u64,
}

impl<'a> AssetResolver<'a> {
    fn new(
        tool_output_root: PathBuf,
        workspace_mount: Option<&'a Path>,
        extraction_root: &Path,
    ) -> Result<Self, TransferError> {
        Ok(Self {
            tool_output_root,
            workspace_mount,
            extraction_root: extraction_root.to_path_buf(),
            assets: BTreeMap::new(),
            tool_output_mappings: BTreeMap::new(),
            copied_bytes: 0,
        })
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
                let Some(SerializedSqlValue::Text { value }) = row.values.get_mut(*column) else {
                    continue;
                };
                let mut decoded: serde_json::Value =
                    serde_json::from_str(value).map_err(|error| {
                        TransferError::Blocked(format!(
                            "native {}.{} data is not valid JSON: {error}",
                            row.table, column
                        ))
                    })?;
                let tree_reference_context = row.table == "session" && *column == "revert";
                if self.walk_json(&mut decoded, tree_reference_context)? {
                    *value = serde_json::to_string(&decoded)
                        .map_err(|error| TransferError::Serialization(error.to_string()))?;
                }
            }
        }
        Ok(())
    }

    fn walk_json(
        &mut self,
        value: &mut serde_json::Value,
        tree_reference_context: bool,
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
                    let replacement = self.resolve_file_url(&url)?;
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
                    self.record_git_tree(tree)?;
                }
                if tree_reference_context {
                    if let Some(reference) = object.get("snapshot").or_else(|| object.get("tree")) {
                        let tree = reference.as_str().ok_or_else(|| {
                            TransferError::Blocked(
                                "revert snapshot reference is not a Git object ID".into(),
                            )
                        })?;
                        self.record_git_tree(tree)?;
                    }
                }
                for nested in object.values_mut() {
                    changed |= self.walk_json(nested, false)?;
                }
                Ok(changed)
            }
            serde_json::Value::Array(values) => {
                let mut changed = false;
                for nested in values {
                    changed |= self.walk_json(nested, tree_reference_context)?;
                }
                Ok(changed)
            }
            serde_json::Value::String(text) => self.rewrite_tool_output_markers(text),
            _ => Ok(false),
        }
    }

    fn resolve_file_url(&mut self, url: &str) -> Result<String, TransferError> {
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
        let asset = self.verify_workspace_file(&path)?;
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

    fn tool_output_root(&self) -> Result<PathBuf, TransferError> {
        fs::canonicalize(&self.tool_output_root).map_err(|error| {
            TransferError::Blocked(format!(
                "pinned OpenCode tool-output directory is unavailable: {error}"
            ))
        })
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

    fn copy_tool_output(&mut self, path: &Path) -> Result<String, TransferError> {
        let root = self.tool_output_root()?;
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            TransferError::Blocked(format!(
                "pinned OpenCode tool-output file is unavailable: {error}"
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(TransferError::Blocked(
                "tool-output reference is not a regular write-once file".into(),
            ));
        }
        let canonical = fs::canonicalize(path).map_err(|error| {
            TransferError::Blocked(format!("tool-output path cannot be resolved: {error}"))
        })?;
        let name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                TransferError::Blocked("tool-output path has no valid file name".into())
            })?;
        if canonical.parent() != Some(root.as_path())
            || !name.starts_with("tool_")
            || name.len() <= 5
        {
            return Err(TransferError::Blocked(
                "tool-output reference is outside the pinned write-once directory".into(),
            ));
        }
        if let Some(target) = self.tool_output_mappings.get(&canonical) {
            return Ok(target.clone());
        }

        let source_relative_path = name.to_string();
        let file = File::open(&canonical).map_err(|error| {
            TransferError::Blocked(format!("tool-output file cannot be read: {error}"))
        })?;
        let before = file.metadata()?;
        let assets_directory = self.extraction_root.join("assets").join("sha256");
        fs::create_dir_all(&assets_directory)?;
        let mut temporary = Builder::new()
            .prefix("asset-")
            .tempfile_in(&assets_directory)?;
        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 256 * 1024];
        let mut reader = file;
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            copied = copied
                .checked_add(count as u64)
                .ok_or_else(|| TransferError::Blocked("tool-output bundle size overflow".into()))?;
            if self.copied_bytes.saturating_add(copied) > MAX_BUNDLE_BYTES {
                return Err(TransferError::Blocked(
                    "exact-session bundle exceeds 8 GiB".into(),
                ));
            }
            hasher.update(&buffer[..count]);
            temporary.write_all(&buffer[..count])?;
        }
        let after = reader.metadata()?;
        if before.len() != copied
            || after.len() != copied
            || before.modified().ok() != after.modified().ok()
        {
            return Err(TransferError::Blocked(
                "write-once tool-output bytes changed while being snapshotted".into(),
            ));
        }
        let sha256 = hex::encode(hasher.finalize());
        let target_relative_path = format!("assets/sha256/{sha256}");
        let target = self.extraction_root.join(&target_relative_path);
        if target.exists() {
            let existing_digest = digest_reader(&mut File::open(&target)?)?;
            if existing_digest != sha256 {
                return Err(TransferError::Blocked(
                    "content-addressed asset path contains different bytes".into(),
                ));
            }
        } else {
            temporary.flush()?;
            temporary.as_file().sync_all()?;
            temporary
                .persist(&target)
                .map_err(|error| TransferError::Io(error.error.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o400))?;
            }
        }
        self.copied_bytes = self.copied_bytes.saturating_add(copied);
        self.tool_output_mappings
            .insert(canonical.clone(), target_relative_path.clone());
        let metadata = SerializedAssetMetadata {
            kind: "write_once_tool_output".into(),
            source_relative_path,
            target_relative_path: target_relative_path.clone(),
            size_bytes: copied,
            sha256,
        };
        self.assets.insert(target_relative_path.clone(), metadata);
        Ok(target_relative_path)
    }

    fn verify_workspace_file(&self, path: &Path) -> Result<SerializedAssetMetadata, TransferError> {
        let workspace_mount = self.workspace_mount.ok_or_else(|| {
            TransferError::Blocked(
                "native file path cannot be verified without the exact workspace mount".into(),
            )
        })?;
        let mount = fs::canonicalize(workspace_mount).map_err(|error| {
            TransferError::Blocked(format!("exact workspace mount is unavailable: {error}"))
        })?;
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
        let relative = canonical.strip_prefix(&mount).map_err(|_| {
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

    fn record_git_tree(&mut self, tree: &str) -> Result<(), TransferError> {
        if self.assets.values().any(|asset| {
            asset.kind == "git_tree_reference" && asset.source_relative_path.ends_with(tree)
        }) {
            return Ok(());
        }
        let mount = self.workspace_mount.ok_or_else(|| {
            TransferError::Blocked(
                "snapshot reference cannot be verified without the exact workspace mount".into(),
            )
        })?;
        let store = inspect_git_tree(mount, tree)?;
        let metadata = SerializedAssetMetadata {
            kind: "git_tree_reference".into(),
            source_relative_path: store.identity.clone(),
            target_relative_path: store.identity,
            size_bytes: store.closure_bytes,
            sha256: store.closure_sha256,
        };
        self.assets
            .insert(metadata.target_relative_path.clone(), metadata);
        Ok(())
    }
}

fn decode_file_url(url: &str) -> Result<PathBuf, TransferError> {
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
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(TransferError::Blocked(
            "file URL must resolve to an absolute path".into(),
        ));
    }
    Ok(path)
}

struct GitTreeInspection {
    identity: String,
    closure_bytes: u64,
    closure_sha256: String,
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
    let top_level = git_output(&mount, &["rev-parse", "--show-toplevel"])?;
    let top_level = PathBuf::from(String::from_utf8_lossy(&top_level.stdout).trim());
    let top_level = fs::canonicalize(top_level).map_err(|error| {
        TransferError::Blocked(format!("workspace Git root cannot be resolved: {error}"))
    })?;
    if top_level != mount {
        return Err(TransferError::Blocked(
            "snapshot Git root is not the exact managed workspace mount".into(),
        ));
    }
    let git_dir = git_path(&mount, "--absolute-git-dir")?;
    let common_dir = git_path(&mount, "--git-common-dir")?;
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
    if !git_dir.starts_with(&mount) || !common_dir.starts_with(&mount) {
        return Err(TransferError::Blocked(
            "snapshot object store is outside the exact managed workspace mount".into(),
        ));
    }
    let object_format = String::from_utf8_lossy(
        &git_output(&mount, &["rev-parse", "--show-object-format"])?.stdout,
    )
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
    let objects_dir = common_dir.join("objects");
    let alternates = objects_dir.join("info").join("alternates");
    let mut alternate_identity = Vec::new();
    if let Ok(contents) = fs::read_to_string(&alternates) {
        for line in contents.lines().filter(|line| !line.trim().is_empty()) {
            let candidate = PathBuf::from(line);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                objects_dir.join(candidate)
            };
            let candidate = fs::canonicalize(candidate).map_err(|error| {
                TransferError::Blocked(format!(
                    "alternate Git object store is unavailable: {error}"
                ))
            })?;
            if !candidate.starts_with(&mount) {
                return Err(TransferError::Blocked(
                    "alternate Git object store is outside the exact managed workspace mount"
                        .into(),
                ));
            }
            let relative = candidate.strip_prefix(&mount).map_err(|_| {
                TransferError::Blocked(
                    "alternate Git object store is outside the exact managed workspace mount"
                        .into(),
                )
            })?;
            alternate_identity.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    let object_type = git_text(&mount, &["cat-file", "-t", tree])?;
    if object_type.trim() != "tree" {
        return Err(TransferError::Blocked(
            "snapshot reference does not name a Git tree object".into(),
        ));
    }
    let entries = git_output(&mount, &["ls-tree", "-r", "-t", "-z", tree])?;
    let mut objects = BTreeSet::new();
    objects.insert(tree.to_string());
    for entry in entries
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let header_end = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| TransferError::Blocked("Git tree contains an invalid entry".into()))?;
        let header = std::str::from_utf8(&entry[..header_end])
            .map_err(|_| TransferError::Blocked("Git tree entry metadata is not UTF-8".into()))?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 3 || fields[1] == "commit" {
            return Err(TransferError::Blocked(
                "snapshot tree contains an unsupported submodule entry".into(),
            ));
        }
        objects.insert(fields[2].to_string());
    }
    let mut object_records = Vec::with_capacity(objects.len());
    let mut closure_bytes = 0_u64;
    for object in objects {
        let object_kind = git_text(&mount, &["cat-file", "-t", &object])?;
        let object_size = git_text(&mount, &["cat-file", "-s", &object])?
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

fn git_path(mount: &Path, argument: &str) -> Result<PathBuf, TransferError> {
    let output = git_output(mount, &["rev-parse", argument])?;
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
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

fn git_text(mount: &Path, arguments: &[&str]) -> Result<String, TransferError> {
    let output = git_output(mount, arguments)?;
    String::from_utf8(output.stdout)
        .map_err(|_| TransferError::Blocked("Git returned non-UTF-8 metadata".into()))
}

fn git_output(mount: &Path, arguments: &[&str]) -> Result<Output, TransferError> {
    let output = Command::new("git")
        .args(["-C", mount.to_string_lossy().as_ref()])
        .args(arguments)
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .map_err(|error| {
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
            fs::create_dir_all(path)?;
            true
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
    #[cfg(not(unix))]
    let _ = newly_created;
    Ok(path.to_path_buf())
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
    let expected_schema = pinned_schema_fingerprint(
        actual.contains("message_seq"),
        actual.contains("provider_config"),
    )?;
    if schema_fingerprint(connection)? != expected_schema {
        return Err(TransferError::Blocked(
            "source DDL does not match the pinned OpenCode v1.18.21 schema".into(),
        ));
    }
    Ok(())
}

fn pinned_schema_fingerprint(
    include_message_seq: bool,
    include_provider_config: bool,
) -> Result<String, TransferError> {
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
    schema_fingerprint(&expected)
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
        "WITH RECURSIVE descendants(id) AS (
           SELECT id FROM session WHERE id = ?1 AND parent_id IS NULL
           UNION
           SELECT child.id FROM session child
           JOIN descendants parent ON child.parent_id = parent.id
         )
         SELECT session.* FROM session
         JOIN descendants USING (id)
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
        _ => &["id"],
    }
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
