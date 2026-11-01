//! Transactional installation of an exact OpenCode history bundle.
//!
//! The importer streams a checksummed payload into the pinned native schema,
//! refuses conflicting destination rows, and re-reads the selected graph before
//! committing. Later launches read the current root rather than auditing its
//! historical mutations.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_BUNDLE_BYTES,
};
use freshell_sessions::opencode_transfer::{
    OpenCodeTransferManifest, SavedSnapshotAvailability, SavedSnapshotReference,
    SavedSnapshotSummary, SerializedAssetMetadata, SerializedRow, SerializedSqlValue,
};
use rusqlite::{
    params_from_iter,
    types::{Value, ValueRef},
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{
    de::{self, DeserializeSeed},
    Deserialize, Serialize,
};
use sha2::{Digest, Sha256};

const DESTINATION_SCHEMA: &str = "opencode-1.18.21";
const DESTINATION_IMPORT_OVERHEAD_BYTES: u64 = 1024 * 1024;

/// Test seam and production contract for checking the provider volume before
/// creating any destination directories or opening SQLite.
pub trait DestinationCapacityProvider {
    fn available_bytes(&self, existing_directory: &Path) -> io::Result<u64>;
}

pub struct FilesystemCapacityProvider;

impl DestinationCapacityProvider for FilesystemCapacityProvider {
    fn available_bytes(&self, existing_directory: &Path) -> io::Result<u64> {
        #[cfg(unix)]
        {
            let path = std::ffi::CString::new(existing_directory.as_os_str().as_encoded_bytes())
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid capacity path")
                })?;
            let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
            let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            let stats = unsafe { stats.assume_init() };
            Ok(statvfs_available_bytes(&stats))
        }
        #[cfg(not(unix))]
        {
            let _ = existing_directory;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "provider-volume capacity check is unavailable on this platform",
            ))
        }
    }
}

// libc exposes statvfs counters at the target's native unsigned-long width;
// widen both before multiplying so 32-bit Unix builds keep the same byte math.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)]
fn statvfs_available_bytes(stats: &libc::statvfs) -> u64 {
    (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
}

#[derive(Debug, thiserror::Error)]
pub enum OpenCodeImportError {
    #[error("OpenCode import is blocked: {0}")]
    Blocked(String),
    #[error("OpenCode import I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("OpenCode import database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("OpenCode import metadata is invalid: {0}")]
    Metadata(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    pub version: u32,
    pub transfer_id: String,
    pub destination_store_id: String,
    pub destination_database_path: String,
    pub root_session_id: String,
    pub source_store_id: String,
    pub source_generation: String,
    pub source_schema_fingerprint: String,
    pub migration_journal_fingerprint: String,
    pub target_image_ref: String,
    pub target_build_receipt: String,
    pub bundle_sha256: String,
    pub row_count: u64,
    pub asset_count: u64,
    pub structural_sha256: String,
    #[serde(default)]
    pub saved_snapshot_summary: freshell_sessions::opencode_transfer::SavedSnapshotSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledStoreReadable {
    pub version: u32,
    pub transfer_id: String,
    pub destination_store_id: String,
    pub root_session_id: String,
    pub source_generation: String,
    pub target_image_ref: String,
    pub target_build_receipt: String,
    pub provider_uid: u32,
    pub provider_gid: u32,
    pub home: String,
    pub xdg_data_home: String,
    pub xdg_config_home: String,
    pub opencode_db: String,
    pub cwd: String,
    pub row_count: u64,
    pub asset_count: u64,
    pub structural_sha256: String,
    #[serde(default)]
    pub saved_snapshot_summary: freshell_sessions::opencode_transfer::SavedSnapshotSummary,
}

/// The current readable root tail. Empty means the exact native messages read
/// succeeded and found no active root messages; the TUI must still confirm it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "data", rename_all = "snake_case")]
pub enum VerifiedRootTail {
    Message { message_id: String },
    QualifiedEmpty,
}

/// Body-free generation and display-tail evidence for one verified store
/// snapshot. The hash identifies the current rows without returning message
/// bodies to the supervisor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentOpenCodeEvidence {
    pub version: u32,
    pub transfer_id: String,
    pub destination_store_id: String,
    pub root_session_id: String,
    pub import_generation: String,
    pub evidence_generation: String,
    pub root_tail: VerifiedRootTail,
    pub row_count: u64,
    pub asset_count: u64,
    #[serde(default)]
    pub saved_snapshot_summary: freshell_sessions::opencode_transfer::SavedSnapshotSummary,
}

#[derive(Debug, Clone, Copy)]
pub struct InstalledStoreReaderContext<'a> {
    pub database_path: &'a Path,
    pub workspace_root: &'a Path,
    pub provider_uid: u32,
    pub provider_gid: u32,
    pub home: &'a Path,
    pub xdg_data_home: &'a Path,
    pub xdg_config_home: &'a Path,
    pub cwd: &'a Path,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageMetadata {
    descriptor: OpenCodeTransferDescriptor,
}

/// Import the payload file at file index zero from a verified read-only stage.
/// This function rechecks its own input hashes so callers cannot accidentally
/// substitute a path that was checked earlier and then changed.
pub fn import_bundle(
    descriptor: &OpenCodeTransferDescriptor,
    staged_directory: &Path,
    destination_database: &Path,
    workspace_root: &Path,
) -> Result<ImportReceipt, OpenCodeImportError> {
    validate_descriptor(descriptor)?;
    let payload_path = verify_staged_bundle(descriptor, staged_directory)?;
    let payload = File::open(&payload_path)?;
    import_bundle_payload(descriptor, payload, destination_database, workspace_root)
}

/// Verify the exact supervisor-owned ready directory and return its payload
/// path. The caller must keep the verified read-only mount in place while it
/// opens the returned file.
pub fn verify_staged_bundle(
    descriptor: &OpenCodeTransferDescriptor,
    staged_directory: &Path,
) -> Result<PathBuf, OpenCodeImportError> {
    validate_descriptor(descriptor)?;
    verify_stage_directory(staged_directory, descriptor)?;
    Ok(staged_file_path(staged_directory, &descriptor.files[0]))
}

/// Import a payload stream after the caller has authenticated the staged
/// descriptor and file. This supports the managed handoff where the trusted
/// session host opens the root-only read-only stage and streams the payload
/// over a pipe to the provider-UID importer; the provider cannot open the
/// staged mount itself. The stream is hashed as it is consumed inside the
/// destination transaction, so a truncated or changed stream rolls back.
pub fn import_bundle_payload<R: Read>(
    descriptor: &OpenCodeTransferDescriptor,
    payload: R,
    destination_database: &Path,
    workspace_root: &Path,
) -> Result<ImportReceipt, OpenCodeImportError> {
    import_bundle_payload_with_capacity(
        descriptor,
        payload,
        destination_database,
        workspace_root,
        &FilesystemCapacityProvider,
    )
}

pub fn import_bundle_payload_with_capacity<R: Read>(
    descriptor: &OpenCodeTransferDescriptor,
    payload: R,
    destination_database: &Path,
    workspace_root: &Path,
    capacity: &impl DestinationCapacityProvider,
) -> Result<ImportReceipt, OpenCodeImportError> {
    validate_descriptor(descriptor)?;
    let manifest = parse_manifest(descriptor)?;
    if manifest.payload_bytes != descriptor.files[0].size_bytes
        || manifest.payload_sha256 != descriptor.files[0].sha256
    {
        return Err(OpenCodeImportError::Blocked(
            "streamed payload metadata does not match the pinned manifest".into(),
        ));
    }

    let parent = destination_database.parent().ok_or_else(|| {
        OpenCodeImportError::Blocked("destination database has no parent directory".into())
    })?;
    reject_symlink_components(destination_database)?;
    let capacity_root = nearest_existing_directory(parent)?;
    let available = capacity.available_bytes(&capacity_root)?;
    let required = descriptor
        .total_bytes
        .checked_add(DESTINATION_IMPORT_OVERHEAD_BYTES)
        .ok_or_else(|| {
            OpenCodeImportError::Blocked("destination size estimate overflowed".into())
        })?;
    if available < required {
        return Err(OpenCodeImportError::Blocked(
            "provider volume has insufficient free space for the OpenCode history import".into(),
        ));
    }
    fs::create_dir_all(parent)?;

    let mut connection = Connection::open(destination_database)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ensure_destination_schema(&transaction)?;
    let mut imported_keys = BTreeSet::new();
    let mut hashing_reader = HashingReader::new(payload);
    let payload_metadata = {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut hashing_reader);
        let metadata = PayloadSeed {
            transaction: &transaction,
            manifest: &manifest,
            imported_keys: &mut imported_keys,
            destination_database,
        }
        .deserialize(&mut deserializer)
        .map_err(|error| {
            if error.to_string().starts_with(
                "OpenCode import is blocked: destination has a conflicting native primary key",
            ) {
                return OpenCodeImportError::Blocked(
                    "destination has a conflicting native primary key".into(),
                );
            }
            OpenCodeImportError::Blocked(format!("staged payload is invalid: {error}"))
        })?;
        deserializer.end().map_err(|_| {
            OpenCodeImportError::Blocked("staged payload has trailing or malformed data".into())
        })?;
        metadata
    };
    if hashing_reader.bytes != manifest.payload_bytes
        || hex::encode(hashing_reader.hasher.finalize()) != manifest.payload_sha256
    {
        return Err(OpenCodeImportError::Blocked(
            "payload stream digest changed during import".into(),
        ));
    }
    validate_foreign_keys(&transaction)?;
    let session_ids = read_descendant_session_ids(&transaction, &manifest.root_session_id)?;
    let current_rows = read_current_session_rows(&transaction, &session_ids)?;
    if current_rows.keys().cloned().collect::<BTreeSet<_>>() != imported_keys {
        return Err(OpenCodeImportError::Blocked(
            "installed store differs from the transferred native graph".into(),
        ));
    }
    validate_current_rows(&current_rows)?;
    current_root_tail(&manifest.root_session_id, &current_rows)?;
    let session_rows = current_rows
        .values()
        .filter(|row| row.table == "session")
        .cloned()
        .collect::<Vec<_>>();
    freshell_sessions::opencode_transfer::verify_saved_snapshot_references(
        &payload_metadata.saved_snapshots,
        &session_rows,
        destination_database,
        workspace_root,
    )
    .map_err(|error| OpenCodeImportError::Blocked(error.to_string()))?;
    freshell_sessions::opencode_transfer::verify_asset_references(
        &payload_metadata.assets,
        &session_rows,
        workspace_root,
    )
    .map_err(|error| OpenCodeImportError::Blocked(error.to_string()))?;
    #[cfg(all(test, unix))]
    crash_checkpoint("import.before_transaction_commit");
    transaction.commit()?;
    #[cfg(all(test, unix))]
    crash_checkpoint("import.after_transaction_commit");
    drop(connection);
    sync_file_and_parent(destination_database)?;
    #[cfg(all(test, unix))]
    crash_checkpoint("import.after_database_sync");
    let structural_sha256 = structural_digest(&manifest);
    let receipt = receipt_for(descriptor, &manifest, structural_sha256);
    #[cfg(all(test, unix))]
    crash_checkpoint("import.after_receipt_constructed");
    Ok(receipt)
}

fn nearest_existing_directory(path: &Path) -> Result<PathBuf, OpenCodeImportError> {
    for candidate in path.ancestors() {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                return Ok(candidate.to_path_buf());
            }
            Ok(_) => {
                return Err(OpenCodeImportError::Blocked(
                    "provider destination ancestor is not a real directory".into(),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(OpenCodeImportError::Blocked(
        "provider destination has no existing filesystem ancestor".into(),
    ))
}

/// Verify an installed baseline with a read-only connection. Session-host runs
/// this from a setpriv child under the provider UID with the provider's exact
/// HOME/XDG/OPENCODE_DB and working directory.
pub fn verify_installed_store(
    descriptor: &OpenCodeTransferDescriptor,
    reader: &InstalledStoreReaderContext<'_>,
) -> Result<InstalledStoreReadable, OpenCodeImportError> {
    let InstalledStoreReaderContext {
        database_path,
        workspace_root: _,
        provider_uid,
        provider_gid,
        home,
        xdg_data_home,
        xdg_config_home,
        cwd,
    } = *reader;
    validate_descriptor(descriptor)?;
    if descriptor.target_build_receipt
        != opencode_target_build_receipt(&descriptor.target_image_ref, DESTINATION_SCHEMA)
    {
        return Err(OpenCodeImportError::Blocked(
            "target provider build receipt is not qualified for the pinned schema".into(),
        ));
    }
    let expected_database = xdg_data_home.join("opencode/opencode.db");
    if database_path != expected_database
        || descriptor.destination_database_path != ".local/share/opencode/opencode.db"
        || xdg_data_home != home.join(".local/share")
        || xdg_config_home != home.join(".config")
    {
        return Err(OpenCodeImportError::Blocked(
            "provider environment does not select the imported destination database".into(),
        ));
    }
    #[cfg(unix)]
    if unsafe { libc::geteuid() } != provider_uid || unsafe { libc::getegid() } != provider_gid {
        return Err(OpenCodeImportError::Blocked(
            "installed-store reader did not run under the provider identity".into(),
        ));
    }
    let manifest = parse_manifest(descriptor)?;
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", "ON")?;
    verify_destination_schema(&connection)?;
    validate_foreign_keys(&connection)?;
    let ids = read_descendant_session_ids(&connection, &manifest.root_session_id)?;
    let rows = read_current_session_rows(&connection, &ids)?;
    if rows.len() != manifest.row_count {
        return Err(OpenCodeImportError::Blocked(
            "installed native graph has a different row count".into(),
        ));
    }
    validate_current_rows(&rows)?;
    current_root_tail(&manifest.root_session_id, &rows)?;
    let structural_sha256 = structural_digest(&manifest);
    Ok(InstalledStoreReadable {
        saved_snapshot_summary: freshell_sessions::opencode_transfer::saved_snapshot_summary(
            &manifest,
        ),
        version: 1,
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        root_session_id: descriptor.root_session_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        target_image_ref: descriptor.target_image_ref.clone(),
        target_build_receipt: descriptor.target_build_receipt.clone(),
        provider_uid,
        provider_gid,
        home: home.to_string_lossy().into_owned(),
        xdg_data_home: xdg_data_home.to_string_lossy().into_owned(),
        xdg_config_home: xdg_config_home.to_string_lossy().into_owned(),
        opencode_db: database_path.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        row_count: manifest.row_count as u64,
        asset_count: manifest.asset_count() as u64,
        structural_sha256,
    })
}

/// Read the current selected root and its surviving descendants for a later
/// managed launch. Native edits, compaction, and child deletion do not need to
/// reproduce the imported history or its old event log.
pub fn verify_current_store(
    descriptor: &OpenCodeTransferDescriptor,
    database_path: &Path,
    _workspace_root: &Path,
) -> Result<CurrentOpenCodeEvidence, OpenCodeImportError> {
    validate_descriptor(descriptor)?;
    let manifest = parse_manifest(descriptor)?;
    let mut connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", "ON")?;
    // All evidence comes from one coherent SQLite snapshot.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    verify_destination_schema(&transaction)?;
    validate_foreign_keys(&transaction)?;
    let ids = read_descendant_session_ids(&transaction, &manifest.root_session_id)?;
    let current_rows = read_current_session_rows(&transaction, &ids)?;
    validate_current_rows(&current_rows)?;
    let root_tail = current_root_tail(&manifest.root_session_id, &current_rows)?;
    let evidence_generation = current_evidence_generation(descriptor, &current_rows, &manifest)?;
    transaction.commit()?;
    Ok(CurrentOpenCodeEvidence {
        saved_snapshot_summary: freshell_sessions::opencode_transfer::saved_snapshot_summary(
            &manifest,
        ),
        version: 1,
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        root_session_id: manifest.root_session_id.clone(),
        import_generation: manifest.generation.clone(),
        evidence_generation,
        root_tail,
        row_count: current_rows.len() as u64,
        asset_count: manifest.asset_count() as u64,
    })
}

fn read_descendant_session_ids(
    connection: &Connection,
    root_session_id: &str,
) -> Result<BTreeSet<String>, OpenCodeImportError> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE selected(id) AS (
             SELECT id FROM session WHERE id=?1
             UNION
             SELECT child.id FROM session child JOIN selected parent
               ON child.parent_id=parent.id
         )
         SELECT id FROM selected ORDER BY id",
    )?;
    let ids = statement
        .query_map([root_session_id], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    if ids.len() > 50_000 || !ids.contains(root_session_id) {
        return Err(OpenCodeImportError::Blocked(
            "the exact OpenCode root or descendant graph is unavailable".into(),
        ));
    }
    Ok(ids)
}

fn read_rows_where_values(
    connection: &Connection,
    table: &str,
    column: &str,
    values: &BTreeSet<String>,
) -> Result<Vec<SerializedRow>, OpenCodeImportError> {
    if values.is_empty() {
        return Ok(Vec::new());
    }
    let columns = table_columns(connection, table)?;
    let selected = columns
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let primary_keys = primary_key_columns(table).ok_or_else(|| {
        OpenCodeImportError::Blocked("current store contains an unsupported native table".into())
    })?;
    let order = primary_keys
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = (1..=values.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT {selected} FROM \"{table}\" WHERE \"{column}\" IN ({placeholders}) ORDER BY {order}"
    );
    let values = values.iter().cloned().map(Value::Text).collect::<Vec<_>>();
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| {
            sqlite_row_to_serialized(row, table, &columns, primary_keys)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn read_rows_for_directory(
    connection: &Connection,
    project_id: &str,
    directory: &str,
) -> Result<Vec<SerializedRow>, OpenCodeImportError> {
    let table = "project_directory";
    let columns = table_columns(connection, table)?;
    let selected = columns
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = connection.prepare(&format!(
        "SELECT {selected} FROM project_directory WHERE project_id=?1 AND directory=?2"
    ))?;
    let primary_keys = primary_key_columns(table).ok_or_else(|| {
        OpenCodeImportError::Blocked("current store contains an unsupported native table".into())
    })?;
    let rows = statement
        .query_map([project_id, directory], |row| {
            sqlite_row_to_serialized(row, table, &columns, primary_keys)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn read_current_session_rows(
    connection: &Connection,
    session_ids: &BTreeSet<String>,
) -> Result<BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>, OpenCodeImportError> {
    let mut rows = BTreeMap::new();
    for (table, column) in [
        ("session", "id"),
        ("message", "session_id"),
        ("part", "session_id"),
        ("event_sequence", "aggregate_id"),
        ("event", "aggregate_id"),
        ("session_message", "session_id"),
        ("session_input", "session_id"),
        ("session_context_epoch", "session_id"),
        ("todo", "session_id"),
    ] {
        for row in read_rows_where_values(connection, table, column, session_ids)? {
            rows.insert((row.table.clone(), row.key.clone()), row);
        }
    }
    let session_rows = rows
        .values()
        .filter(|row| row.table == "session")
        .cloned()
        .collect::<Vec<_>>();
    let project_ids = session_rows
        .iter()
        .map(|row| value_text(row, "project_id"))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>();
    for (table, key_column) in [("permission", "project_id"), ("project", "id")] {
        for row in read_rows_where_values(connection, table, key_column, &project_ids)? {
            rows.insert((row.table.clone(), row.key.clone()), row);
        }
    }
    let workspace_ids = session_rows
        .iter()
        .map(|row| value_text(row, "workspace_id"))
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>();
    for row in read_rows_where_values(connection, "workspace", "id", &workspace_ids)? {
        rows.insert((row.table.clone(), row.key.clone()), row);
    }
    let mut directories = BTreeSet::new();
    for session in &session_rows {
        if let (Some(project_id), Some(directory)) = (
            value_text(session, "project_id")?,
            value_text(session, "directory")?,
        ) {
            directories.insert((project_id, directory));
        }
    }
    for (project_id, directory) in directories {
        for row in read_rows_for_directory(connection, &project_id, &directory)? {
            rows.insert((row.table.clone(), row.key.clone()), row);
        }
    }
    Ok(rows)
}

/// Validate the JSON records the native history readers actually consume.
/// Historical events may have been compacted or removed by OpenCode itself.
fn validate_current_rows(
    rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
) -> Result<(), OpenCodeImportError> {
    for row in rows
        .values()
        .filter(|row| matches!(row.table.as_str(), "message" | "part" | "session_message"))
    {
        let valid = match row.values.get("data") {
            Some(SerializedSqlValue::Text { value }) => {
                serde_json::from_str::<serde_json::Value>(value)
                    .is_ok_and(|value| value.is_object())
            }
            _ => false,
        };
        if !valid {
            return Err(OpenCodeImportError::Blocked(format!(
                "current native {} contains unreadable JSON",
                row.table
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum SqlNumber {
    Integer(i64),
    Real(f64),
}

fn sql_number(row: &SerializedRow, key: &str) -> Option<SqlNumber> {
    row.values.get(key).and_then(serialized_sql_number)
}

fn serialized_sql_number(value: &SerializedSqlValue) -> Option<SqlNumber> {
    match value {
        SerializedSqlValue::Integer { value } => Some(SqlNumber::Integer(*value)),
        SerializedSqlValue::Real { bits } => {
            let bits = u64::from_str_radix(bits, 16).ok()?;
            let value = f64::from_bits(bits);
            value.is_finite().then_some(SqlNumber::Real(value))
        }
        _ => None,
    }
}

fn compare_sql_numbers(left: SqlNumber, right: SqlNumber) -> Ordering {
    match (left, right) {
        (SqlNumber::Integer(left), SqlNumber::Integer(right)) => left.cmp(&right),
        (SqlNumber::Real(left), SqlNumber::Real(right)) => {
            left.partial_cmp(&right).unwrap_or(Ordering::Equal)
        }
        (SqlNumber::Integer(left), SqlNumber::Real(right)) => compare_i64_to_f64(left, right),
        (SqlNumber::Real(left), SqlNumber::Integer(right)) => {
            compare_i64_to_f64(right, left).reverse()
        }
    }
}

fn compare_i64_to_f64(integer: i64, real: f64) -> Ordering {
    const I64_UPPER_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;
    if real < i64::MIN as f64 {
        return Ordering::Greater;
    }
    if real >= I64_UPPER_EXCLUSIVE {
        return Ordering::Less;
    }
    match integer.cmp(&(real.trunc() as i64)) {
        Ordering::Equal if real.fract() > 0.0 => Ordering::Less,
        Ordering::Equal if real.fract() < 0.0 => Ordering::Greater,
        ordering => ordering,
    }
}

fn value_text(row: &SerializedRow, key: &str) -> Result<Option<String>, OpenCodeImportError> {
    match row.values.get(key) {
        Some(SerializedSqlValue::Null) | None => Ok(None),
        Some(SerializedSqlValue::Text { value }) => Ok(Some(value.clone())),
        _ => Err(OpenCodeImportError::Blocked(format!(
            "current native row has a non-text {key} value"
        ))),
    }
}

fn value_integer_required(row: &SerializedRow, key: &str) -> Result<i64, OpenCodeImportError> {
    match row.values.get(key) {
        Some(SerializedSqlValue::Integer { value }) => Ok(*value),
        _ => Err(OpenCodeImportError::Blocked(format!(
            "native row has no valid {key} sequence"
        ))),
    }
}

fn current_root_tail(
    root_session_id: &str,
    rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
) -> Result<VerifiedRootTail, OpenCodeImportError> {
    let selected = |table: &str| {
        rows.values()
            .filter(|row| row.table == table)
            .cloned()
            .collect::<Vec<_>>()
    };
    derive_root_tail(
        root_session_id,
        &selected("session"),
        &selected("message"),
        &selected("session_message"),
    )
}

fn derive_root_tail(
    root_session_id: &str,
    sessions: &[SerializedRow],
    messages: &[SerializedRow],
    session_messages: &[SerializedRow],
) -> Result<VerifiedRootTail, OpenCodeImportError> {
    let root = sessions
        .iter()
        .find(|row| value_text(row, "id").ok().flatten().as_deref() == Some(root_session_id))
        .ok_or_else(|| {
            OpenCodeImportError::Blocked("the imported root session is missing".into())
        })?;
    let has_v2_history = session_messages.iter().any(|row| {
        value_text(row, "session_id").ok().flatten().as_deref() == Some(root_session_id)
    });
    let ordered = if has_v2_history {
        let mut rows = session_messages
            .iter()
            .filter(|row| {
                value_text(row, "session_id").ok().flatten().as_deref() == Some(root_session_id)
            })
            .map(|row| {
                Ok((
                    value_integer_required(row, "seq")?,
                    value_text(row, "id")?.ok_or_else(|| {
                        OpenCodeImportError::Blocked("root V2 message has no exact ID".into())
                    })?,
                ))
            })
            .collect::<Result<Vec<_>, OpenCodeImportError>>()?;
        rows.sort();
        rows.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
    } else {
        let mut rows = messages
            .iter()
            .filter(|row| {
                value_text(row, "session_id").ok().flatten().as_deref() == Some(root_session_id)
            })
            .map(|row| {
                Ok((
                    sql_number(row, "time_created").ok_or_else(|| {
                        OpenCodeImportError::Blocked(
                            "root message has no finite creation timestamp".into(),
                        )
                    })?,
                    value_text(row, "id")?.ok_or_else(|| {
                        OpenCodeImportError::Blocked("root message has no exact ID".into())
                    })?,
                ))
            })
            .collect::<Result<Vec<_>, OpenCodeImportError>>()?;
        rows.sort_by(|left, right| {
            compare_sql_numbers(left.0, right.0).then_with(|| left.1.cmp(&right.1))
        });
        rows.into_iter().map(|(_, id)| id).collect::<Vec<_>>()
    };
    if let Some(revert) = value_text(root, "revert")? {
        let revert: serde_json::Value = serde_json::from_str(&revert).map_err(|_| {
            OpenCodeImportError::Blocked("the active revert boundary is malformed".into())
        })?;
        let boundary = revert
            .get("messageID")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                OpenCodeImportError::Blocked("the active revert boundary has no message ID".into())
            })?;
        let index = ordered
            .iter()
            .position(|id| id == boundary)
            .ok_or_else(|| {
                OpenCodeImportError::Blocked("the active revert boundary is not in the root".into())
            })?;
        if revert
            .get("partID")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            return Ok(VerifiedRootTail::Message {
                message_id: boundary.to_owned(),
            });
        }
        if index == 0 {
            return Ok(VerifiedRootTail::QualifiedEmpty);
        }
        return Ok(VerifiedRootTail::Message {
            message_id: ordered[index - 1].clone(),
        });
    }
    Ok(match ordered.last() {
        Some(message_id) => VerifiedRootTail::Message {
            message_id: message_id.clone(),
        },
        None => VerifiedRootTail::QualifiedEmpty,
    })
}

fn current_evidence_generation(
    descriptor: &OpenCodeTransferDescriptor,
    rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    manifest: &OpenCodeTransferManifest,
) -> Result<String, OpenCodeImportError> {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-opencode-current-evidence-v1\0");
    hasher.update(descriptor.destination_store_id.as_bytes());
    hasher.update([0]);
    hasher.update(descriptor.root_session_id.as_bytes());
    hasher.update([0]);
    hasher.update(manifest.generation.as_bytes());
    for ((table, key), row) in rows {
        hasher.update(table.as_bytes());
        hasher.update([0]);
        hasher.update(serde_json::to_vec(key).map_err(|_| {
            OpenCodeImportError::Metadata("native row key cannot be encoded".into())
        })?);
        hasher.update([0]);
        hasher.update(digest_serialized_row(row)?.as_bytes());
    }
    Ok(hex::encode(hasher.finalize()))
}

fn validate_descriptor(descriptor: &OpenCodeTransferDescriptor) -> Result<(), OpenCodeImportError> {
    descriptor
        .validate()
        .map_err(|_| OpenCodeImportError::Blocked("transfer descriptor is invalid".into()))?;
    if descriptor.provider_schema != DESTINATION_SCHEMA
        || descriptor.total_bytes > MAX_OPENCODE_TRANSFER_BUNDLE_BYTES
        || descriptor.files.len() != 1
        || descriptor
            .files
            .first()
            .map(|file| file.relative_path.as_str())
            != Some("payload.json")
        || serde_json::from_str::<OpenCodeTransferManifest>(&descriptor.manifest_json)
            .ok()
            .is_none_or(|manifest| {
                manifest.assets.iter().any(|asset| {
                    !matches!(
                        asset.kind.as_str(),
                        "workspace_path_reference" | "git_tree_reference"
                    )
                })
            })
        || descriptor.bundle_sha256
            != opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files)
    {
        return Err(OpenCodeImportError::Blocked(
            "transfer is not a supported OpenCode bundle".into(),
        ));
    }
    Ok(())
}

fn parse_manifest(
    descriptor: &OpenCodeTransferDescriptor,
) -> Result<OpenCodeTransferManifest, OpenCodeImportError> {
    let manifest: OpenCodeTransferManifest = serde_json::from_str(&descriptor.manifest_json)
        .map_err(|_| OpenCodeImportError::Metadata("manifest shape is invalid".into()))?;
    if !matches!(manifest.version, 1 | 2)
        || manifest.provider_schema != DESTINATION_SCHEMA
        || manifest.root_session_id != descriptor.root_session_id
        || manifest.source_store_id != descriptor.source_store_id
        || manifest.generation != descriptor.source_generation
        || manifest.source_schema_fingerprint != descriptor.source_schema_fingerprint
        || manifest.migration_journal_fingerprint != descriptor.migration_journal_fingerprint
        || (manifest.version == 1 && manifest.row_count != manifest.rows.len())
        || manifest.payload_bytes != descriptor.files[0].size_bytes
        || manifest.payload_sha256 != descriptor.files[0].sha256
    {
        return Err(OpenCodeImportError::Metadata(
            "manifest identity or counts disagree with the transfer".into(),
        ));
    }
    let mut unsigned = manifest.clone();
    unsigned.generation.clear();
    let encoded = serde_json::to_vec(&unsigned)
        .map_err(|_| OpenCodeImportError::Metadata("manifest cannot be encoded".into()))?;
    if manifest.version == 2 && sha256(&encoded) != manifest.generation {
        return Err(OpenCodeImportError::Metadata(
            "manifest generation fingerprint is invalid".into(),
        ));
    }
    Ok(manifest)
}

fn verify_stage_directory(
    path: &Path,
    descriptor: &OpenCodeTransferDescriptor,
) -> Result<(), OpenCodeImportError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(OpenCodeImportError::Blocked(
            "staged bundle is not a real directory".into(),
        ));
    }
    let descriptor_path = path.join("descriptor.json");
    let descriptor_metadata = fs::symlink_metadata(&descriptor_path)?;
    if descriptor_metadata.file_type().is_symlink() || !descriptor_metadata.is_file() {
        return Err(OpenCodeImportError::Blocked(
            "staged descriptor is not a regular file".into(),
        ));
    }
    let staged: StageMetadata = serde_json::from_slice(&fs::read(descriptor_path)?)
        .map_err(|_| OpenCodeImportError::Blocked("staged descriptor is invalid".into()))?;
    if staged.descriptor != *descriptor {
        return Err(OpenCodeImportError::Blocked(
            "staged descriptor identity does not match the launch".into(),
        ));
    }
    let ready_path = path.join("READY");
    let ready_metadata = fs::symlink_metadata(&ready_path)?;
    if ready_metadata.file_type().is_symlink()
        || !ready_metadata.is_file()
        || fs::read(ready_path)? != descriptor.bundle_sha256.as_bytes()
    {
        return Err(OpenCodeImportError::Blocked(
            "staged ready marker does not match the bundle".into(),
        ));
    }
    let expected_names = std::iter::once("descriptor.json".to_string())
        .chain(std::iter::once("READY".to_string()))
        .chain(
            descriptor
                .files
                .iter()
                .map(|file| format!("entry-{:04}.bin", file.index)),
        )
        .collect::<BTreeSet<_>>();
    let actual_names = fs::read_dir(path)?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(OpenCodeImportError::from)
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if actual_names != expected_names {
        return Err(OpenCodeImportError::Blocked(
            "staged directory contains missing or unlisted files".into(),
        ));
    }
    for file in &descriptor.files {
        let (size, digest) = hash_file(&staged_file_path(path, file))?;
        if size != file.size_bytes || digest != file.sha256 {
            return Err(OpenCodeImportError::Blocked(
                "staged file differs from the transfer descriptor".into(),
            ));
        }
    }
    Ok(())
}

fn staged_file_path(directory: &Path, file: &OpenCodeTransferFile) -> PathBuf {
    directory.join(format!("entry-{:04}.bin", file.index))
}

fn hash_file(path: &Path) -> Result<(u64, String), OpenCodeImportError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(OpenCodeImportError::Blocked(
            "staged bundle file is not a regular file".into(),
        ));
    }
    if metadata.len() > MAX_OPENCODE_TRANSFER_BUNDLE_BYTES {
        return Err(OpenCodeImportError::Blocked(
            "staged bundle file exceeds the 8 GiB limit".into(),
        ));
    }
    let mut reader = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 256 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    Ok((bytes, hex::encode(hasher.finalize())))
}

fn reject_symlink_components(path: &Path) -> Result<(), OpenCodeImportError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(OpenCodeImportError::Blocked(
                    "destination database path contains a symbolic link".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn ensure_destination_schema(transaction: &Transaction<'_>) -> Result<(), OpenCodeImportError> {
    let table_count: i64 = transaction.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )?;
    if table_count == 0 {
        transaction
            .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())?;
        for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
            transaction.execute(
                "INSERT INTO migration (id,time_completed) VALUES (?1,0)",
                [migration],
            )?;
        }
    }
    verify_destination_schema(transaction)
}

fn verify_destination_schema(connection: &Connection) -> Result<(), OpenCodeImportError> {
    let actual = schema_fingerprint(connection)?;
    let expected = freshell_sessions::opencode_transfer::pinned_destination_schema_fingerprint()
        .map_err(|_| {
            OpenCodeImportError::Blocked("pinned destination schema is unavailable".into())
        })?;
    if actual != expected {
        return Err(OpenCodeImportError::Blocked(
            "destination database schema does not match the pinned OpenCode build".into(),
        ));
    }
    let mut statement = connection.prepare("SELECT id FROM migration ORDER BY id")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let expected = freshell_sessions::opencode_transfer::pinned_destination_migration_ids()
        .iter()
        .map(|value| (*value).to_string())
        .collect::<BTreeSet<_>>();
    if ids != expected {
        return Err(OpenCodeImportError::Blocked(
            "destination migration journal does not match the pinned OpenCode build".into(),
        ));
    }
    let mut statement = connection.prepare("SELECT name FROM data_migration ORDER BY name")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    let expected = freshell_sessions::opencode_transfer::pinned_destination_data_migration_ids()
        .iter()
        .map(|value| (*value).to_string())
        .collect::<BTreeSet<_>>();
    if ids != expected {
        return Err(OpenCodeImportError::Blocked(
            "destination data-migration journal is unsupported".into(),
        ));
    }
    Ok(())
}

fn schema_fingerprint(connection: &Connection) -> Result<String, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name,tbl_name",
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
    Ok(sha256(&serde_json::to_vec(&rows).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(error))
    })?))
}

fn validate_foreign_keys(connection: &Connection) -> Result<(), OpenCodeImportError> {
    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if rows.next()?.is_some() {
        return Err(OpenCodeImportError::Blocked(
            "destination graph contains a dangling native relationship".into(),
        ));
    }
    Ok(())
}

fn read_row_by_key(
    connection: &Connection,
    table: &str,
    key: &[SerializedSqlValue],
) -> Result<SerializedRow, OpenCodeImportError> {
    let pk = primary_key_columns(table).ok_or_else(|| {
        OpenCodeImportError::Blocked("manifest contains an unsupported native table".into())
    })?;
    if pk.len() != key.len() {
        return Err(OpenCodeImportError::Metadata(
            "manifest primary key has an invalid shape".into(),
        ));
    }
    let columns = table_columns(connection, table)?;
    let predicates = pk
        .iter()
        .enumerate()
        .map(|(index, column)| format!("\"{column}\"=?{}", index + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let selected = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT {selected} FROM \"{table}\" WHERE {predicates}");
    let sql_values = key.iter().map(sql_value).collect::<Result<Vec<_>, _>>()?;
    let mut statement = connection.prepare(&sql)?;
    let row = statement
        .query_row(params_from_iter(sql_values.iter()), |row| {
            sqlite_row_to_serialized(row, table, &columns, pk)
        })
        .optional()?
        .ok_or_else(|| OpenCodeImportError::Blocked("an imported native row is missing".into()))?;
    Ok(row)
}

fn insert_or_compare_row(
    transaction: &Transaction<'_>,
    row: &SerializedRow,
) -> Result<(), OpenCodeImportError> {
    let pk = primary_key_columns(&row.table).ok_or_else(|| {
        OpenCodeImportError::Blocked("payload contains an unsupported native table".into())
    })?;
    let columns = table_columns(transaction, &row.table)?;
    let row_columns = row.values.keys().cloned().collect::<BTreeSet<_>>();
    let schema_columns = columns.iter().cloned().collect::<BTreeSet<_>>();
    if row_columns != schema_columns {
        return Err(OpenCodeImportError::Blocked(
            "payload row does not match the pinned native table shape".into(),
        ));
    }
    let expected_key = pk
        .iter()
        .map(|column| {
            row.values.get(*column).cloned().ok_or_else(|| {
                OpenCodeImportError::Blocked("payload row omits a native primary key".into())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if expected_key != row.key {
        return Err(OpenCodeImportError::Blocked(
            "payload row primary key does not match its value map".into(),
        ));
    }
    match read_row_by_key(transaction, &row.table, &row.key) {
        Ok(existing) if existing == *row => return Ok(()),
        Ok(_) => {
            return Err(OpenCodeImportError::Blocked(
                "destination has a conflicting native primary key".into(),
            ));
        }
        Err(OpenCodeImportError::Blocked(message))
            if message == "an imported native row is missing" => {}
        Err(error) => return Err(error),
    }
    let names = row.values.keys().collect::<Vec<_>>();
    let placeholders = (1..=names.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let quoted = names
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(",");
    let values = names
        .iter()
        .map(|name| sql_value(row.values.get(*name).expect("key came from the same map")))
        .collect::<Result<Vec<_>, _>>()?;
    transaction.execute(
        &format!(
            "INSERT INTO \"{}\" ({quoted}) VALUES ({placeholders})",
            row.table
        ),
        params_from_iter(values.iter()),
    )?;
    Ok(())
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, OpenCodeImportError> {
    if primary_key_columns(table).is_none() {
        return Err(OpenCodeImportError::Blocked(
            "payload contains an unsupported native table".into(),
        ));
    }
    let mut statement = connection.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn primary_key_columns(table: &str) -> Option<&'static [&'static str]> {
    match table {
        "project_directory" => Some(&["project_id", "directory"]),
        "todo" => Some(&["session_id", "position"]),
        "event_sequence" => Some(&["aggregate_id"]),
        "session_context_epoch" => Some(&["session_id"]),
        "project" | "workspace" | "permission" | "session" | "message" | "part" | "event"
        | "session_message" | "session_input" => Some(&["id"]),
        _ => None,
    }
}

fn sqlite_row_to_serialized(
    row: &rusqlite::Row<'_>,
    table: &str,
    columns: &[String],
    primary_keys: &[&str],
) -> rusqlite::Result<SerializedRow> {
    let mut values = BTreeMap::new();
    for (index, name) in columns.iter().enumerate() {
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
        values.insert(name.clone(), value);
    }
    let key = primary_keys
        .iter()
        .map(|column| {
            values
                .get(*column)
                .cloned()
                .ok_or(rusqlite::Error::InvalidQuery)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SerializedRow {
        table: table.into(),
        key,
        values,
    })
}

fn sql_value(value: &SerializedSqlValue) -> Result<Value, OpenCodeImportError> {
    match value {
        SerializedSqlValue::Null => Ok(Value::Null),
        SerializedSqlValue::Integer { value } => Ok(Value::Integer(*value)),
        SerializedSqlValue::Real { bits } => {
            let bits = u64::from_str_radix(bits, 16).map_err(|_| {
                OpenCodeImportError::Metadata("native real value is malformed".into())
            })?;
            Ok(Value::Real(f64::from_bits(bits)))
        }
        SerializedSqlValue::Text { value } => Ok(Value::Text(value.clone())),
        SerializedSqlValue::Blob { hex } => Ok(Value::Blob(hex::decode(hex).map_err(|_| {
            OpenCodeImportError::Metadata("native blob value is malformed".into())
        })?)),
    }
}

fn digest_serialized_row(row: &SerializedRow) -> Result<String, OpenCodeImportError> {
    let bytes = serde_json::to_vec(row)
        .map_err(|_| OpenCodeImportError::Metadata("native row cannot be encoded".into()))?;
    Ok(sha256(&bytes))
}

fn structural_digest(manifest: &OpenCodeTransferManifest) -> String {
    let mut hasher = Sha256::new();
    if manifest.version == 1 {
        // Existing receipts keep their identity; new transfers do not carry
        // the historical per-row metadata that the old format included.
        hasher.update(b"freshell-opencode-import-receipt-v1\0");
        hasher.update(manifest.generation.as_bytes());
        hasher.update(manifest.payload_sha256.as_bytes());
        for row in &manifest.rows {
            hasher.update(row.table.as_bytes());
            hasher.update([0]);
            hasher.update(serde_json::to_vec(&row.key).unwrap_or_default());
            hasher.update(row.sha256.as_bytes());
            hasher.update([0]);
        }
        for asset in &manifest.assets {
            hasher.update(serde_json::to_vec(asset).unwrap_or_default());
            hasher.update([0]);
        }
        return hex::encode(hasher.finalize());
    }
    hasher.update(b"freshell-opencode-import-receipt-v2\0");
    hasher.update(manifest.generation.as_bytes());
    hasher.update(manifest.payload_sha256.as_bytes());
    hasher.update(manifest.root_session_id.as_bytes());
    hasher.update((manifest.row_count as u64).to_le_bytes());
    hex::encode(hasher.finalize())
}

fn receipt_for(
    descriptor: &OpenCodeTransferDescriptor,
    manifest: &OpenCodeTransferManifest,
    structural_sha256: String,
) -> ImportReceipt {
    ImportReceipt {
        saved_snapshot_summary: freshell_sessions::opencode_transfer::saved_snapshot_summary(
            manifest,
        ),
        version: 1,
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        destination_database_path: descriptor.destination_database_path.clone(),
        root_session_id: descriptor.root_session_id.clone(),
        source_store_id: descriptor.source_store_id.clone(),
        source_generation: descriptor.source_generation.clone(),
        source_schema_fingerprint: descriptor.source_schema_fingerprint.clone(),
        migration_journal_fingerprint: descriptor.migration_journal_fingerprint.clone(),
        target_image_ref: descriptor.target_image_ref.clone(),
        target_build_receipt: descriptor.target_build_receipt.clone(),
        bundle_sha256: descriptor.bundle_sha256.clone(),
        row_count: manifest.row_count as u64,
        asset_count: manifest.asset_count() as u64,
        structural_sha256,
    }
}

fn sync_file_and_parent(path: &Path) -> Result<(), OpenCodeImportError> {
    File::open(path)?.sync_all()?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(all(test, unix))]
fn crash_checkpoint(point: &str) {
    if std::env::var("FRESHELL_OPENCODE_IMPORT_CRASH_POINT")
        .ok()
        .as_deref()
        == Some(point)
    {
        // The self-reexec test verifies SIGKILL and runs only through the
        // disposable Docker sandbox.
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
        unreachable!("SIGKILL should terminate the importer crash fixture");
    }
}

struct HashingReader<R> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
}

impl<R> HashingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        self.bytes = self.bytes.saturating_add(count as u64);
        self.hasher.update(&buffer[..count]);
        Ok(count)
    }
}

struct PayloadMetadata {
    assets: Vec<SerializedAssetMetadata>,
    saved_snapshots: Vec<SavedSnapshotReference>,
}

struct PayloadSeed<'a, 'connection> {
    transaction: &'a Transaction<'connection>,
    manifest: &'a OpenCodeTransferManifest,
    imported_keys: &'a mut BTreeSet<(String, Vec<SerializedSqlValue>)>,
    destination_database: &'a Path,
}

impl<'de, 'a, 'connection> de::DeserializeSeed<'de> for PayloadSeed<'a, 'connection> {
    type Value = PayloadMetadata;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(PayloadVisitor(self))
    }
}

struct PayloadVisitor<'a, 'connection>(PayloadSeed<'a, 'connection>);

impl<'de, 'a, 'connection> de::Visitor<'de> for PayloadVisitor<'a, 'connection> {
    type Value = PayloadMetadata;
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an OpenCode transfer payload")
    }
    fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut version = None;
        let mut root = None;
        let mut rows_seen = false;
        let mut assets = None;
        let mut saved_snapshots = None;
        let mut snapshot_objects_seen = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" if version.is_none() => version = Some(map.next_value::<u32>()?),
                "root_session_id" if root.is_none() => root = Some(map.next_value::<String>()?),
                "rows" if !rows_seen => {
                    rows_seen = true;
                    map.next_value_seed(RowsSeed {
                        transaction: self.0.transaction,
                        expected_count: self.0.manifest.row_count,
                        imported_keys: self.0.imported_keys,
                    })?;
                }
                "assets" if assets.is_none() => {
                    assets = Some(map.next_value::<Vec<SerializedAssetMetadata>>()?)
                }
                "saved_snapshots" if saved_snapshots.is_none() => {
                    saved_snapshots = Some(map.next_value::<Vec<SavedSnapshotReference>>()?)
                }
                "snapshot_objects" if !snapshot_objects_seen => {
                    snapshot_objects_seen = true;
                    let references = saved_snapshots
                        .as_deref()
                        .or_else(|| {
                            (self.0.manifest.version == 1)
                                .then_some(self.0.manifest.saved_snapshots.as_slice())
                        })
                        .ok_or_else(|| {
                            de::Error::custom("snapshot references must precede their objects")
                        })?;
                    map.next_value_seed(SnapshotObjectsSeed {
                        references,
                        destination_database: self.0.destination_database,
                    })?;
                }
                "version" | "root_session_id" | "rows" | "assets" | "saved_snapshots"
                | "snapshot_objects" => return Err(de::Error::custom("duplicate payload field")),
                _ => {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
        }
        let assets = assets.ok_or_else(|| de::Error::custom("payload assets are missing"))?;
        let saved_snapshots = saved_snapshots
            .or_else(|| {
                (self.0.manifest.version == 1).then(|| self.0.manifest.saved_snapshots.clone())
            })
            .ok_or_else(|| de::Error::custom("payload snapshot references are missing"))?;
        let summary = SavedSnapshotSummary::QualifiedReferences {
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
        };
        if version != Some(self.0.manifest.version)
            || root.as_deref() != Some(self.0.manifest.root_session_id.as_str())
            || !rows_seen
            || assets.len() != self.0.manifest.asset_count()
            || (self.0.manifest.version == 1 && assets != self.0.manifest.assets)
            || (self.0.manifest.version == 2 && summary != self.0.manifest.saved_snapshot_summary)
            || (!snapshot_objects_seen
                && saved_snapshots
                    .iter()
                    .any(|reference| !reference.objects.is_empty()))
        {
            return Err(de::Error::custom(
                "payload metadata disagrees with its manifest",
            ));
        }
        Ok(PayloadMetadata {
            assets,
            saved_snapshots,
        })
    }
}

struct SnapshotObjectsSeed<'a> {
    references: &'a [SavedSnapshotReference],
    destination_database: &'a Path,
}
impl<'de> de::DeserializeSeed<'de> for SnapshotObjectsSeed<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_seq(self)
    }
}
impl<'de> de::Visitor<'de> for SnapshotObjectsSeed<'_> {
    type Value = ();
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the retained snapshot object closure")
    }
    fn visit_seq<A: de::SeqAccess<'de>>(self, mut sequence: A) -> Result<(), A::Error> {
        let mut seen = BTreeSet::new();
        while let Some(object) = sequence
            .next_element::<freshell_sessions::opencode_transfer::SerializedSnapshotObject>(
        )? {
            if !seen.insert((
                object.project_id.clone(),
                object.worktree_sha1.clone(),
                object.object_id.clone(),
            )) {
                return Err(de::Error::custom("duplicate snapshot object"));
            }
            freshell_sessions::opencode_transfer::install_snapshot_object(
                &object,
                self.references,
                self.destination_database,
            )
            .map_err(de::Error::custom)?;
        }
        let expected = self
            .references
            .iter()
            .flat_map(|reference| {
                reference.objects.iter().map(|object| {
                    (
                        reference.project_id.clone(),
                        reference.worktree_sha1.clone(),
                        object.object_id.clone(),
                    )
                })
            })
            .collect::<BTreeSet<_>>();
        if seen != expected {
            return Err(de::Error::custom(
                "snapshot payload does not match the retained closure",
            ));
        }
        Ok(())
    }
}

struct RowsSeed<'a, 'connection> {
    transaction: &'a Transaction<'connection>,
    expected_count: usize,
    imported_keys: &'a mut BTreeSet<(String, Vec<SerializedSqlValue>)>,
}
impl<'de, 'a, 'connection> de::DeserializeSeed<'de> for RowsSeed<'a, 'connection> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(RowsVisitor(self))
    }
}
struct RowsVisitor<'a, 'connection>(RowsSeed<'a, 'connection>);
impl<'de, 'a, 'connection> de::Visitor<'de> for RowsVisitor<'a, 'connection> {
    type Value = ();
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the exported native row sequence")
    }
    fn visit_seq<S: de::SeqAccess<'de>>(self, mut sequence: S) -> Result<Self::Value, S::Error> {
        while let Some(row) = sequence.next_element::<SerializedRow>()? {
            if self.0.imported_keys.len() >= self.0.expected_count
                || !self
                    .0
                    .imported_keys
                    .insert((row.table.clone(), row.key.clone()))
            {
                return Err(de::Error::custom(
                    "payload has duplicate or unexpected native rows",
                ));
            }
            insert_or_compare_row(self.0.transaction, &row).map_err(de::Error::custom)?;
        }
        if self.0.imported_keys.len() != self.0.expected_count {
            return Err(de::Error::custom("payload is missing native rows"));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "opencode_transfer_tests.rs"]
mod tests;
