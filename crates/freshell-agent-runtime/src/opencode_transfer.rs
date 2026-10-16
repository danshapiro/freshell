//! Transactional installation of an exact OpenCode history bundle.
//!
//! The importer accepts only the pinned Task 1 bundle shape. It creates the
//! pinned destination schema when needed, inserts rows without overwriting a
//! conflict, and independently re-reads the installed rows before returning a
//! body-free receipt.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_BUNDLE_BYTES,
};
use freshell_sessions::opencode_transfer::{
    NativeMessageBaseline, NativeRevertBoundary, OpenCodeTransferManifest, SerializedAssetMetadata,
    SerializedRow, SerializedSqlValue,
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
const JS_DATE_MAX_EPOCH_MILLISECONDS: f64 = 8_640_000_000_000_000.0;

type SerializedFieldDigests = BTreeMap<String, String>;
type CurrentRowFieldDigests = (SerializedFieldDigests, SerializedFieldDigests);

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

/// The current root tail verified against the immutable import manifest and
/// its typed provider transitions. Empty means the exact native messages read
/// succeeded and found no active root messages; the TUI must still confirm it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "data", rename_all = "snake_case")]
pub enum VerifiedRootTail {
    Message { message_id: String },
    QualifiedEmpty,
}

/// Body-free generation and display-tail evidence for one verified store
/// snapshot. The hash commits to exact current rows and referenced assets;
/// message bodies are hashed but never returned or logged.
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
    let mut row_index = 0_usize;
    let mut hashing_reader = HashingReader::new(payload);
    {
        let mut deserializer = serde_json::Deserializer::from_reader(&mut hashing_reader);
        PayloadSeed {
            transaction: &transaction,
            manifest: &manifest,
            row_index: &mut row_index,
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
            OpenCodeImportError::Blocked("staged payload structure or row digest is invalid".into())
        })?;
        deserializer.end().map_err(|_| {
            OpenCodeImportError::Blocked("staged payload has trailing or malformed data".into())
        })?;
    }
    if hashing_reader.bytes != manifest.payload_bytes
        || hex::encode(hashing_reader.hasher.finalize()) != manifest.payload_sha256
    {
        return Err(OpenCodeImportError::Blocked(
            "payload stream digest changed during import".into(),
        ));
    }
    validate_foreign_keys(&transaction)?;
    verify_manifest_rows(&transaction, &manifest)?;
    verify_exact_installed_closure(&transaction, &manifest)?;
    let session_rows = read_manifest_session_rows(&transaction, &manifest)?;
    freshell_sessions::opencode_transfer::verify_saved_snapshot_references(
        &manifest.saved_snapshots,
        &session_rows,
        destination_database,
        workspace_root,
    )
    .map_err(|error| OpenCodeImportError::Blocked(error.to_string()))?;
    freshell_sessions::opencode_transfer::verify_asset_references(
        &manifest.assets,
        &session_rows,
        workspace_root,
    )
    .map_err(|_| {
        OpenCodeImportError::Blocked(
            "workspace or Git assets do not match the imported session references".into(),
        )
    })?;
    #[cfg(test)]
    crash_checkpoint("import.before_transaction_commit");
    transaction.commit()?;
    #[cfg(test)]
    crash_checkpoint("import.after_transaction_commit");
    drop(connection);
    sync_file_and_parent(destination_database)?;
    #[cfg(test)]
    crash_checkpoint("import.after_database_sync");
    let structural_sha256 = structural_digest(&manifest);
    let receipt = receipt_for(descriptor, &manifest, structural_sha256);
    #[cfg(test)]
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
        workspace_root,
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
    verify_manifest_rows(&connection, &manifest)?;
    verify_exact_installed_closure(&connection, &manifest)?;
    validate_foreign_keys(&connection)?;
    let session_rows = read_manifest_session_rows(&connection, &manifest)?;
    freshell_sessions::opencode_transfer::verify_saved_snapshot_references(
        &manifest.saved_snapshots,
        &session_rows,
        database_path,
        workspace_root,
    )
    .map_err(|error| OpenCodeImportError::Blocked(error.to_string()))?;
    freshell_sessions::opencode_transfer::verify_asset_references(
        &manifest.assets,
        &session_rows,
        workspace_root,
    )
    .map_err(|_| {
        OpenCodeImportError::Blocked(
            "provider identity cannot read an imported workspace or Git asset".into(),
        )
    })?;
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
        asset_count: manifest.assets.len() as u64,
        structural_sha256,
    })
}

/// Verify the installed session for a later managed OpenCode launch. Unlike
/// the stopped repair receipt above, this accepts only provider evolution that
/// is represented by supported, contiguous native events. It never replaces
/// the import-time baseline with a new whole-store digest.
pub fn verify_current_store(
    descriptor: &OpenCodeTransferDescriptor,
    database_path: &Path,
    workspace_root: &Path,
) -> Result<CurrentOpenCodeEvidence, OpenCodeImportError> {
    validate_descriptor(descriptor)?;
    let manifest = parse_manifest(descriptor)?;
    let mut connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.pragma_update(None, "query_only", "ON")?;
    // Hold one SQLite read snapshot across graph selection, row checks, event
    // chain validation, and evidence hashing. Without this, an append between
    // table reads could produce a generation that never existed as a commit.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
    verify_destination_schema(&transaction)?;
    validate_foreign_keys(&transaction)?;

    let current_session_ids = read_descendant_session_ids(&transaction, &manifest.root_session_id)?;
    let baseline_session_ids = manifest
        .rows
        .iter()
        .filter(|row| row.table == "session")
        .map(|row| key_text(&row.key))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if !baseline_session_ids.is_subset(&current_session_ids) {
        return Err(OpenCodeImportError::Blocked(
            "an imported session or descendant was deleted".into(),
        ));
    }

    let mut current_rows = read_current_session_rows(&transaction, &current_session_ids)?;
    for baseline in &manifest.rows {
        let key = (baseline.table.clone(), baseline.key.clone());
        if current_rows.contains_key(&key) {
            continue;
        }
        if matches!(
            baseline.table.as_str(),
            "message" | "part" | "todo" | "session_message" | "session_input"
        ) {
            continue;
        }
        let row = read_row_by_key(&transaction, &baseline.table, &baseline.key)?;
        current_rows.insert(key, row);
    }
    let verified_removals = verify_native_cleanup_transitions(&manifest, &current_rows)?;
    verify_typed_current_rows(&manifest, &current_rows, &verified_removals)?;
    let current_event_rows = current_rows
        .values()
        .filter(|row| row.table == "event")
        .cloned()
        .collect::<Vec<_>>();
    verify_current_event_chains(&manifest, &current_rows, &current_event_rows)?;
    let current_session_rows = current_rows
        .values()
        .filter(|row| row.table == "session")
        .cloned()
        .collect::<Vec<_>>();
    let message_rows = current_rows
        .values()
        .filter(|row| row.table == "message")
        .cloned()
        .collect::<Vec<_>>();
    let session_message_rows = current_rows
        .values()
        .filter(|row| row.table == "session_message")
        .cloned()
        .collect::<Vec<_>>();
    verify_current_references(&manifest, &current_rows, database_path, workspace_root)?;
    let root_tail = derive_root_tail(
        &manifest.root_session_id,
        &current_session_rows,
        &message_rows,
        &session_message_rows,
    )?;
    let evidence_generation = current_evidence_generation(descriptor, &current_rows, &manifest)?;
    transaction.commit()?;
    Ok(CurrentOpenCodeEvidence {
        saved_snapshot_summary: freshell_sessions::opencode_transfer::saved_snapshot_summary(
            &manifest,
        ),
        version: 1,
        transfer_id: descriptor.transfer_id.clone(),
        destination_store_id: descriptor.destination_store_id.clone(),
        root_session_id: manifest.root_session_id,
        import_generation: manifest.generation,
        evidence_generation,
        root_tail,
        row_count: current_rows.len() as u64,
        asset_count: manifest.assets.len() as u64,
    })
}

fn key_text(key: &[SerializedSqlValue]) -> Result<String, OpenCodeImportError> {
    match key {
        [SerializedSqlValue::Text { value }] if !value.is_empty() => Ok(value.clone()),
        _ => Err(OpenCodeImportError::Blocked(
            "an imported native identity key is malformed".into(),
        )),
    }
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

fn verify_typed_current_rows(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    verified_removals: &BTreeSet<(String, Vec<SerializedSqlValue>)>,
) -> Result<(), OpenCodeImportError> {
    let events = current_rows
        .values()
        .filter(|row| row.table == "event")
        .cloned()
        .collect::<Vec<_>>();
    let baseline = manifest
        .rows
        .iter()
        .map(|row| ((row.table.clone(), row.key.clone()), row))
        .collect::<BTreeMap<_, _>>();
    verify_v2_session_projections(manifest, current_rows, &events)?;
    verify_context_epoch_projection(manifest, current_rows, &events)?;
    verify_todowrite_projection(manifest, current_rows, &events)?;
    let mut changed_rows = Vec::new();
    for (key, digest) in &baseline {
        if matches!(
            digest.table.as_str(),
            "session_message" | "session_input" | "session_context_epoch" | "todo"
        ) {
            // Complete projection validation above proves both current values
            // and native removals. Per-row checks cannot authorize either.
            continue;
        }
        let Some(current) = current_rows.get(key) else {
            if verified_removals.contains(key) {
                continue;
            }
            return Err(OpenCodeImportError::Blocked(
                "an imported native row or edge was deleted".into(),
            ));
        };
        if digest_serialized_row(current)? == digest.sha256 {
            continue;
        }
        // Pinned Project.fromDirectory refreshes this discovery timestamp on
        // every native open. It carries no identity or conversation authority.
        if current.table == "project" {
            let (columns, _) = current_row_field_digests(current)?;
            if columns.len() == digest.column_sha256.len()
                && columns.iter().all(|(column, hash)| {
                    column == "time_updated" || digest.column_sha256.get(column) == Some(hash)
                })
                && digest.transition_cursor.is_some_and(|old| {
                    value_integer(current, "time_updated").is_some_and(|now| now >= old)
                })
            {
                continue;
            }
        }
        if !baseline_row_change_is_typed(digest, current)? {
            let (columns, _) = current_row_field_digests(current)?;
            let changed_columns = columns
                .iter()
                .filter_map(|(column, hash)| {
                    (digest.column_sha256.get(column) != Some(hash)).then_some(column.as_str())
                })
                .collect::<Vec<_>>();
            return Err(OpenCodeImportError::Blocked(format!(
                "an imported native {} row changed outside a supported transition (columns: {})",
                current.table,
                changed_columns.join(",")
            )));
        }
        changed_rows.push(current.clone());
    }

    for (key, current) in current_rows {
        if baseline.contains_key(key) {
            continue;
        }
        if !matches!(
            current.table.as_str(),
            "session"
                | "message"
                | "part"
                | "event_sequence"
                | "event"
                | "session_message"
                | "session_input"
                | "session_context_epoch"
                | "todo"
        ) {
            return Err(OpenCodeImportError::Blocked(
                "an unsupported native row was added to the imported closure".into(),
            ));
        }
        if matches!(
            current.table.as_str(),
            "session_message" | "session_input" | "session_context_epoch"
        ) {
            continue;
        }
        changed_rows.push(current.clone());
    }
    for row in &changed_rows {
        if matches!(
            row.table.as_str(),
            "event"
                | "event_sequence"
                | "todo"
                | "session_message"
                | "session_input"
                | "session_context_epoch"
        ) {
            continue;
        }
        if !row_has_supporting_transition(row, &events)? {
            return Err(OpenCodeImportError::Blocked(format!(
                "a native {} row transition has no matching provider event",
                row.table
            )));
        }
    }
    Ok(())
}

#[derive(Default)]
struct NativeCleanupState {
    revert: Option<NativeRevertBoundary>,
    messages: BTreeMap<String, NativeMessageBaseline>,
    pending: Option<NativeCleanupRemovalSet>,
}

struct NativeCleanupRemovalSet {
    messages: BTreeSet<String>,
    parts: BTreeSet<(String, String)>,
}

fn native_cleanup_refusal() -> OpenCodeImportError {
    OpenCodeImportError::Blocked(
        "native removals do not match a complete saved revert/cleanup transition".into(),
    )
}

fn expected_native_cleanup(
    state: &NativeCleanupState,
) -> Result<NativeCleanupRemovalSet, OpenCodeImportError> {
    let revert = state.revert.as_ref().ok_or_else(native_cleanup_refusal)?;
    let mut ordered = state.messages.values().collect::<Vec<_>>();
    for message in &ordered {
        serialized_sql_number(&message.time_created).ok_or_else(native_cleanup_refusal)?;
    }
    ordered.sort_by(|left, right| {
        compare_sql_numbers(
            serialized_sql_number(&left.time_created).unwrap(),
            serialized_sql_number(&right.time_created).unwrap(),
        )
        .then_with(|| left.message_id.cmp(&right.message_id))
    });
    let boundary = ordered
        .iter()
        .position(|message| message.message_id == revert.message_id)
        .ok_or_else(native_cleanup_refusal)?;
    let messages = ordered
        .iter()
        .skip(boundary + usize::from(revert.part_id.is_some()))
        .map(|message| message.message_id.clone())
        .collect();
    let parts = if let Some(part_id) = &revert.part_id {
        let part_boundary = ordered[boundary]
            .part_ids
            .iter()
            .position(|id| id == part_id)
            .ok_or_else(native_cleanup_refusal)?;
        ordered[boundary]
            .part_ids
            .iter()
            .skip(part_boundary)
            .map(|id| (revert.message_id.clone(), id.clone()))
            .collect()
    } else {
        BTreeSet::new()
    };
    Ok(NativeCleanupRemovalSet { messages, parts })
}

fn native_revert_boundary(
    value: &serde_json::Value,
) -> Result<NativeRevertBoundary, OpenCodeImportError> {
    Ok(NativeRevertBoundary {
        message_id: value
            .get("messageID")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(native_cleanup_refusal)?
            .into(),
        part_id: value
            .get("partID")
            .map(|id| {
                id.as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .ok_or_else(native_cleanup_refusal)
            })
            .transpose()?,
    })
}

/// Replay only pinned native V1 message/part/revert state. A removal becomes
/// authorized only after every exact boundary removal and its native clear
/// event exist. The original manifest remains immutable throughout.
fn verify_native_cleanup_transitions(
    manifest: &OpenCodeTransferManifest,
    rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
) -> Result<BTreeSet<(String, Vec<SerializedSqlValue>)>, OpenCodeImportError> {
    let baseline_events = manifest
        .rows
        .iter()
        .filter(|row| row.table == "event")
        .map(|row| row.key.clone())
        .collect::<BTreeSet<_>>();
    let mut events = rows
        .values()
        .filter(|row| row.table == "event" && !baseline_events.contains(&row.key))
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        value_text(left, "aggregate_id")
            .unwrap_or_default()
            .cmp(&value_text(right, "aggregate_id").unwrap_or_default())
            .then_with(|| value_integer(left, "seq").cmp(&value_integer(right, "seq")))
    });
    if manifest.native_cleanup_baselines.is_empty() {
        if events.iter().any(|row| {
            value_text(row, "type").ok().flatten().is_some_and(|kind| {
                matches!(
                    pinned_event_kind(&kind),
                    Some("message.removed" | "message.part.removed")
                )
            })
        }) {
            return Err(native_cleanup_refusal());
        }
        return Ok(BTreeSet::new());
    }
    let mut states = BTreeMap::new();
    for baseline in &manifest.native_cleanup_baselines {
        let state = NativeCleanupState {
            revert: baseline.revert.clone(),
            messages: baseline
                .messages
                .iter()
                .map(|message| (message.message_id.clone(), message.clone()))
                .collect(),
            pending: None,
        };
        if states.insert(baseline.session_id.clone(), state).is_some() {
            return Err(native_cleanup_refusal());
        }
    }
    let mut deleted = BTreeSet::new();
    let row_key = |table: &str, id: &str| {
        (
            table.to_string(),
            vec![SerializedSqlValue::Text {
                value: id.to_string(),
            }],
        )
    };
    for event in events {
        let raw_kind = value_text(event, "type")?.unwrap_or_default();
        let Some(kind) = pinned_event_kind(&raw_kind) else {
            return Err(native_cleanup_refusal());
        };
        let data = parse_event_data(event)?;
        let session_id = data
            .get("sessionID")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(native_cleanup_refusal)?;
        let state = states
            .entry(session_id.to_string())
            .or_insert_with(NativeCleanupState::default);
        match kind {
            "message.updated" => {
                if state.pending.is_some() {
                    return Err(native_cleanup_refusal());
                }
                let info = data.get("info").ok_or_else(native_cleanup_refusal)?;
                let id = info
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(native_cleanup_refusal)?;
                let time = info
                    .get("time")
                    .and_then(|time| time.get("created"))
                    .ok_or_else(native_cleanup_refusal)?;
                let time_created = if let Some(value) = time.as_i64() {
                    SerializedSqlValue::Integer { value }
                } else {
                    let value = time
                        .as_f64()
                        .filter(|number| number.is_finite())
                        .ok_or_else(native_cleanup_refusal)?;
                    SerializedSqlValue::Real {
                        bits: format!("{:016x}", value.to_bits()),
                    }
                };
                if let Some(existing) = state.messages.get(id) {
                    if compare_sql_numbers(
                        serialized_sql_number(&existing.time_created)
                            .ok_or_else(native_cleanup_refusal)?,
                        serialized_sql_number(&time_created).ok_or_else(native_cleanup_refusal)?,
                    ) != Ordering::Equal
                    {
                        return Err(native_cleanup_refusal());
                    }
                } else {
                    state.messages.insert(
                        id.into(),
                        NativeMessageBaseline {
                            message_id: id.into(),
                            time_created,
                            part_ids: Vec::new(),
                        },
                    );
                }
            }
            "message.part.updated" => {
                if state.pending.is_some() {
                    return Err(native_cleanup_refusal());
                }
                let part = data.get("part").ok_or_else(native_cleanup_refusal)?;
                let message_id = part
                    .get("messageID")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(native_cleanup_refusal)?;
                let id = part
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(native_cleanup_refusal)?;
                let message = state
                    .messages
                    .get_mut(message_id)
                    .ok_or_else(native_cleanup_refusal)?;
                if !message.part_ids.iter().any(|existing| existing == id) {
                    message.part_ids.push(id.into());
                    message.part_ids.sort();
                }
            }
            "message.removed" | "message.part.removed" => {
                if state.pending.is_none() {
                    state.pending = Some(expected_native_cleanup(state)?);
                }
                let pending = state.pending.as_mut().unwrap();
                let message_id = data
                    .get("messageID")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(native_cleanup_refusal)?;
                if kind == "message.removed" {
                    if !pending.messages.remove(message_id) {
                        return Err(native_cleanup_refusal());
                    }
                    let removed = state
                        .messages
                        .remove(message_id)
                        .ok_or_else(native_cleanup_refusal)?;
                    deleted.insert(row_key("message", message_id));
                    for part in removed.part_ids {
                        deleted.insert(row_key("part", &part));
                    }
                } else {
                    let part_id = data
                        .get("partID")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(native_cleanup_refusal)?;
                    if !pending.parts.remove(&(message_id.into(), part_id.into())) {
                        return Err(native_cleanup_refusal());
                    }
                    let message = state
                        .messages
                        .get_mut(message_id)
                        .ok_or_else(native_cleanup_refusal)?;
                    message.part_ids.retain(|id| id != part_id);
                    deleted.insert(row_key("part", part_id));
                }
            }
            "session.updated" => {
                let info = data.get("info").ok_or_else(native_cleanup_refusal)?;
                let next = info
                    .get("revert")
                    .filter(|value| !value.is_null())
                    .map(native_revert_boundary)
                    .transpose()?;
                if let Some(pending) = &state.pending {
                    if next.is_some() || !pending.messages.is_empty() || !pending.parts.is_empty() {
                        return Err(native_cleanup_refusal());
                    }
                    state.pending = None;
                }
                state.revert = next;
            }
            _ => {}
        }
    }
    if states.values().any(|state| state.pending.is_some()) {
        return Err(native_cleanup_refusal());
    }
    for key in &deleted {
        if rows.contains_key(key) {
            return Err(native_cleanup_refusal());
        }
    }
    Ok(deleted)
}

fn verify_todowrite_projection(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    events: &[SerializedRow],
) -> Result<(), OpenCodeImportError> {
    let baseline = manifest
        .rows
        .iter()
        .filter(|row| row.table == "todo")
        .map(|row| ((row.table.clone(), row.key.clone()), row.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let current = current_rows
        .iter()
        .filter(|((table, _), _)| table == "todo")
        .collect::<BTreeMap<_, _>>();
    let mut changed_sessions = BTreeSet::new();
    for (key, old_digest) in &baseline {
        let Some(row) = current.get(key) else {
            let [SerializedSqlValue::Text { value: session_id }, SerializedSqlValue::Integer { .. }] =
                key.1.as_slice()
            else {
                return Err(OpenCodeImportError::Blocked(
                    "todo row has an invalid composite key".into(),
                ));
            };
            changed_sessions.insert(session_id.clone());
            continue;
        };
        if digest_serialized_row(row)? != **old_digest {
            changed_sessions.insert(value_text(row, "session_id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("todo row has no owning session".into())
            })?);
        }
    }
    for (key, row) in &current {
        if !baseline.contains_key(key) {
            changed_sessions.insert(value_text(row, "session_id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("todo row has no owning session".into())
            })?);
        }
    }
    for session_id in changed_sessions {
        let projection = latest_successful_todowrite(events, &session_id)?;
        let actual = current
            .values()
            .filter(|row| {
                value_text(row, "session_id").ok().flatten().as_deref() == Some(&session_id)
            })
            .copied()
            .collect::<Vec<_>>();
        let expected = projection.todos.as_array().ok_or_else(|| {
            OpenCodeImportError::Blocked("durable todowrite input is not an array".into())
        })?;
        if actual.len() != expected.len() {
            return Err(OpenCodeImportError::Blocked(
                "current todo rows do not match the last successful durable todowrite".into(),
            ));
        }
        for (position, (row, todo)) in actual.iter().zip(expected).enumerate() {
            if value_integer(row, "position") != Some(position as i64)
                || value_text(row, "content")?.as_deref()
                    != todo.get("content").and_then(serde_json::Value::as_str)
                || value_text(row, "status")?.as_deref()
                    != todo.get("status").and_then(serde_json::Value::as_str)
                || value_text(row, "priority")?.as_deref()
                    != todo.get("priority").and_then(serde_json::Value::as_str)
                || !todo_timestamps_match_call(row, projection.called_at, projection.succeeded_at)
            {
                return Err(OpenCodeImportError::Blocked(
                    "current todo row values are not the durable successful todowrite projection"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

fn verify_context_epoch_projection(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    _events: &[SerializedRow],
) -> Result<(), OpenCodeImportError> {
    let baseline = manifest
        .rows
        .iter()
        .filter(|row| row.table == "session_context_epoch")
        .map(|row| ((row.table.clone(), row.key.clone()), row))
        .collect::<BTreeMap<_, _>>();
    let mut checked = BTreeSet::new();
    for (key, row) in current_rows
        .iter()
        .filter(|((table, _), _)| table == "session_context_epoch")
    {
        let old = baseline.get(key).ok_or_else(|| {
            OpenCodeImportError::Blocked(
                "a new context epoch has no durable baseline event witness".into(),
            )
        })?;
        checked.insert(key.clone());
        if digest_serialized_row(row)? == old.sha256 {
            continue;
        }
        return Err(OpenCodeImportError::Blocked(
            "the pinned context.updated event does not contain the exact snapshot value".into(),
        ));
    }
    if baseline.keys().any(|key| !checked.contains(key)) {
        return Err(OpenCodeImportError::Blocked(
            "an imported context epoch row was deleted".into(),
        ));
    }
    Ok(())
}

#[derive(Clone)]
struct ProjectedSessionMessage {
    message_type: String,
    seq: i64,
    time_created: i64,
    data: serde_json::Value,
}

#[derive(Clone)]
struct ProjectedSessionInput {
    session_id: String,
    admitted_seq: i64,
    promoted_seq: Option<i64>,
    time_created: i64,
    delivery: String,
    prompt: serde_json::Value,
}

/// Rebuild the pinned V2 projections from the full durable event history.
/// `session_message` assistant and shell rows are mutable projections: a
/// single event can never attest their complete current value.
fn verify_v2_session_projections(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    events: &[SerializedRow],
) -> Result<(), OpenCodeImportError> {
    let mut session_messages = BTreeMap::<(String, String), ProjectedSessionMessage>::new();
    let mut session_inputs = BTreeMap::<(String, String), ProjectedSessionInput>::new();
    let mut ordered_events = events
        .iter()
        .filter_map(|event| {
            Some((
                value_text(event, "aggregate_id").ok().flatten()?,
                value_integer(event, "seq")?,
                event,
            ))
        })
        .collect::<Vec<_>>();
    ordered_events.sort_by(|left, right| (&left.0, left.1).cmp(&(&right.0, right.1)));

    for (session_id, seq, event) in ordered_events {
        let raw_type = value_text(event, "type")?.unwrap_or_default();
        let Some(event_type) = pinned_event_kind(&raw_type) else {
            return Err(OpenCodeImportError::Blocked(
                "provider event type is not in the pinned durable manifest".into(),
            ));
        };
        if !event_type.starts_with("session.next.") {
            continue;
        }
        let data = parse_event_data(event)?;
        validate_v2_event_payload(event_type, &data, &session_id)?;
        apply_v2_projection_event(
            event_type,
            seq,
            &session_id,
            &data,
            &mut session_messages,
            &mut session_inputs,
        )?;
    }

    let current_messages = current_rows
        .values()
        .filter(|row| row.table == "session_message")
        .map(|row| {
            let session_id = value_text(row, "session_id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("session_message row has no session ID".into())
            })?;
            let id = value_text(row, "id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("session_message row has no message ID".into())
            })?;
            Ok(((session_id, id), row))
        })
        .collect::<Result<BTreeMap<_, _>, OpenCodeImportError>>()?;
    if current_messages.len() != session_messages.len() {
        return Err(OpenCodeImportError::Blocked(
            "session_message rows do not equal the durable V2 event projection".into(),
        ));
    }
    for (key, expected) in &session_messages {
        let row = current_messages.get(key).ok_or_else(|| {
            OpenCodeImportError::Blocked(
                "a durable V2 session message is missing from its projection".into(),
            )
        })?;
        if value_text(row, "type")?.as_deref() != Some(expected.message_type.as_str())
            || value_integer_required(row, "seq")? != expected.seq
            || value_integer_required(row, "time_created")? != expected.time_created
            || json_column(row, "data") != Some(expected.data.clone())
        {
            return Err(OpenCodeImportError::Blocked(
                "session_message values do not match replayed durable V2 events".into(),
            ));
        }
        let baseline_row = manifest
            .rows
            .iter()
            .find(|baseline| baseline.table == "session_message" && baseline.key == row.key);
        if !projection_timestamp_matches(row, "time_updated", expected.time_created, baseline_row)?
        {
            return Err(OpenCodeImportError::Blocked(
                "session_message timestamp is not its immutable baseline value or a valid insert timestamp".into(),
            ));
        }
    }

    let current_inputs = current_rows
        .values()
        .filter(|row| row.table == "session_input")
        .map(|row| {
            let session_id = value_text(row, "session_id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("session_input row has no session ID".into())
            })?;
            let id = value_text(row, "id")?.ok_or_else(|| {
                OpenCodeImportError::Blocked("session_input row has no message ID".into())
            })?;
            Ok(((session_id, id), row))
        })
        .collect::<Result<BTreeMap<_, _>, OpenCodeImportError>>()?;
    if current_inputs.len() != session_inputs.len() {
        return Err(OpenCodeImportError::Blocked(
            "session_input rows do not equal the durable prompt lifecycle projection".into(),
        ));
    }
    for (key, expected) in &session_inputs {
        let row = current_inputs.get(key).ok_or_else(|| {
            OpenCodeImportError::Blocked("a durable prompt lifecycle row is missing".into())
        })?;
        let promoted = expected
            .promoted_seq
            .map(|seq| SerializedSqlValue::Integer { value: seq })
            .unwrap_or(SerializedSqlValue::Null);
        if value_text(row, "session_id")?.as_deref() != Some(expected.session_id.as_str())
            || value_integer_required(row, "admitted_seq")? != expected.admitted_seq
            || row.values.get("promoted_seq") != Some(&promoted)
            || value_integer_required(row, "time_created")? != expected.time_created
            || value_text(row, "delivery")?.as_deref() != Some(expected.delivery.as_str())
            || json_column(row, "prompt") != Some(expected.prompt.clone())
        {
            return Err(OpenCodeImportError::Blocked(
                "session_input values do not match their durable prompt events".into(),
            ));
        }
    }
    Ok(())
}

fn projection_timestamp_matches(
    row: &SerializedRow,
    column: &str,
    minimum: i64,
    baseline: Option<&freshell_sessions::opencode_transfer::RowDigest>,
) -> Result<bool, OpenCodeImportError> {
    let Some(timestamp) = value_integer(row, column) else {
        return Ok(false);
    };
    if let Some(baseline) = baseline {
        if let Some(expected_digest) = baseline.column_sha256.get(column) {
            let (columns, _) = current_row_field_digests(row)?;
            return Ok(columns.get(column) == Some(expected_digest));
        }
        // Older manifests do not carry column commitments. They can support
        // only an exact unchanged row, never an event-driven data update.
        return Ok(digest_serialized_row(row)? == baseline.sha256);
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    Ok(timestamp >= minimum && timestamp <= now_ms.saturating_add(60_000))
}

fn validate_v2_event_payload(
    event_type: &str,
    data: &serde_json::Value,
    session_id: &str,
) -> Result<(), OpenCodeImportError> {
    let (required, optional): (&[&str], &[&str]) = match event_type {
        "session.next.agent.switched" => (&["messageID", "agent"], &[]),
        "session.next.model.switched" => (&["messageID", "model"], &[]),
        "session.next.moved" => (&["location"], &["subdirectory"]),
        "session.next.prompted" | "session.next.prompt.admitted" => {
            (&["messageID", "prompt", "delivery"], &[])
        }
        "session.next.context.updated" | "session.next.synthetic" => (&["messageID", "text"], &[]),
        "session.next.shell.started" => (&["messageID", "callID", "command"], &[]),
        "session.next.shell.ended" => (&["callID", "output"], &[]),
        "session.next.step.started" => (&["assistantMessageID", "agent", "model"], &["snapshot"]),
        "session.next.step.ended" => (
            &["assistantMessageID", "finish", "cost", "tokens"],
            &["snapshot", "files"],
        ),
        "session.next.step.failed" => (&["assistantMessageID", "error"], &[]),
        "session.next.text.started" => (&["assistantMessageID", "textID"], &[]),
        "session.next.text.ended" => (&["assistantMessageID", "textID", "text"], &[]),
        "session.next.tool.input.started" => (&["assistantMessageID", "callID", "name"], &[]),
        "session.next.tool.input.ended" => (&["assistantMessageID", "callID", "text"], &[]),
        "session.next.tool.called" => (
            &["assistantMessageID", "callID", "tool", "input", "provider"],
            &[],
        ),
        "session.next.tool.progress" => (
            &["assistantMessageID", "callID", "structured", "content"],
            &[],
        ),
        "session.next.tool.success" => (
            &[
                "assistantMessageID",
                "callID",
                "structured",
                "content",
                "provider",
            ],
            &["outputPaths", "result"],
        ),
        "session.next.tool.failed" => (
            &["assistantMessageID", "callID", "error", "provider"],
            &["result"],
        ),
        "session.next.reasoning.started" => (
            &["assistantMessageID", "reasoningID"],
            &["providerMetadata"],
        ),
        "session.next.reasoning.ended" => (
            &["assistantMessageID", "reasoningID", "text"],
            &["providerMetadata"],
        ),
        "session.next.retried" => (&["attempt", "error"], &[]),
        "session.next.compaction.started" => (&["messageID", "reason"], &[]),
        "session.next.compaction.ended" => (&["messageID", "reason", "text", "recent"], &[]),
        "session.next.revert.staged" => (&["revert"], &[]),
        "session.next.revert.cleared" => (&[], &[]),
        "session.next.revert.committed" => (&["messageID"], &[]),
        _ => {
            return Err(OpenCodeImportError::Blocked(
                "durable V2 event has no pinned projection schema".into(),
            ));
        }
    };
    let Some(object) = data.as_object() else {
        return Err(OpenCodeImportError::Blocked(
            "durable V2 event payload is not an object".into(),
        ));
    };
    let base = ["sessionID", "timestamp"];
    if data.get("sessionID").and_then(serde_json::Value::as_str) != Some(session_id)
        || !valid_session_id(session_id)
        || data
            .get("timestamp")
            .is_none_or(|value| canonical_v2_timestamp_millis(value).is_none())
        || required.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| {
            !base.contains(&key.as_str())
                && !required.contains(&key.as_str())
                && !optional.contains(&key.as_str())
        })
        || !validate_v2_nested_payload(event_type, data)
    {
        return Err(OpenCodeImportError::Blocked(
            "durable V2 event payload does not match its pinned schema".into(),
        ));
    }
    Ok(())
}

fn is_finite_number(value: &serde_json::Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

fn canonical_v2_timestamp_millis(value: &serde_json::Value) -> Option<i64> {
    let milliseconds = value.as_f64()?;
    if !milliseconds.is_finite() || milliseconds.abs() > JS_DATE_MAX_EPOCH_MILLISECONDS {
        return None;
    }
    // The pinned OpenCode DateTimeUtcFromMillis codec uses JavaScript Date
    // TimeClip when decoding and serializes DateTime.toEpochMillis afterward.
    Some(milliseconds.trunc() as i64)
}

fn v2_event_timestamp_millis(data: &serde_json::Value) -> Option<i64> {
    data.get("timestamp")
        .and_then(canonical_v2_timestamp_millis)
}

fn is_nonnegative_finite_number(value: &serde_json::Value) -> bool {
    value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= 0.0)
}

fn is_nonnegative_integer(value: &serde_json::Value) -> bool {
    value.as_u64().is_some()
}

fn is_string(value: &serde_json::Value) -> bool {
    value.as_str().is_some()
}

fn is_workspace_id(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|value| value.starts_with("wrk"))
}

fn valid_session_id(value: &str) -> bool {
    value.starts_with("ses")
}

fn valid_message_id(value: &str) -> bool {
    value.starts_with("msg")
}

fn valid_v2_message_id(value: &str) -> bool {
    value.starts_with("msg_")
}

fn valid_part_id(value: &str) -> bool {
    value.starts_with("prt")
}

fn has_object_shape(value: &serde_json::Value, required: &[&str], optional: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn field_is(
    value: &serde_json::Value,
    key: &str,
    predicate: impl FnOnce(&serde_json::Value) -> bool,
) -> bool {
    value.get(key).is_some_and(predicate)
}

fn optional_field_is(
    value: &serde_json::Value,
    key: &str,
    predicate: impl FnOnce(&serde_json::Value) -> bool,
) -> bool {
    value.get(key).is_none_or(predicate)
}

fn is_string_record(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.values().all(is_string))
}

fn is_unknown_record(value: &serde_json::Value) -> bool {
    value.is_object()
}

fn is_string_array(value: &serde_json::Value) -> bool {
    value
        .as_array()
        .is_some_and(|array| array.iter().all(is_string))
}

fn is_prompt(value: &serde_json::Value) -> bool {
    if !has_object_shape(value, &["text"], &["files", "agents"])
        || !field_is(value, "text", is_string)
    {
        return false;
    }
    optional_field_is(value, "files", |files| {
        files
            .as_array()
            .is_some_and(|files| files.iter().all(is_file_attachment))
    }) && optional_field_is(value, "agents", |agents| {
        agents
            .as_array()
            .is_some_and(|agents| agents.iter().all(is_agent_attachment))
    })
}

fn is_prompt_source(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["start", "end", "text"], &[])
        && field_is(value, "start", is_finite_number)
        && field_is(value, "end", is_finite_number)
        && field_is(value, "text", is_string)
}

fn is_file_attachment(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["uri", "mime"], &["name", "description", "source"])
        && field_is(value, "uri", is_string)
        && field_is(value, "mime", is_string)
        && optional_field_is(value, "name", is_string)
        && optional_field_is(value, "description", is_string)
        && optional_field_is(value, "source", is_prompt_source)
}

fn is_agent_attachment(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["name"], &["source"])
        && field_is(value, "name", is_string)
        && optional_field_is(value, "source", is_prompt_source)
}

fn is_model_ref(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["id", "providerID"], &["variant"])
        && field_is(value, "id", is_string)
        && field_is(value, "providerID", is_string)
        && optional_field_is(value, "variant", is_string)
}

fn is_v2_location_ref(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["directory"], &["workspaceID"])
        && field_is(value, "directory", is_string)
        && optional_field_is(value, "workspaceID", is_workspace_id)
}

fn is_provider_metadata(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|providers| {
        providers
            .values()
            .all(|metadata| metadata.as_object().is_some())
    })
}

fn is_v2_tool_content(value: &serde_json::Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    items.iter().all(
        |item| match item.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => {
                has_object_shape(item, &["type", "text"], &[]) && field_is(item, "text", is_string)
            }
            Some("file") => {
                has_object_shape(item, &["type", "uri", "mime"], &["name"])
                    && field_is(item, "uri", is_string)
                    && field_is(item, "mime", is_string)
                    && optional_field_is(item, "name", is_string)
            }
            _ => false,
        },
    )
}

fn is_provider_result(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["executed"], &["metadata"])
        && field_is(value, "executed", |value| value.as_bool().is_some())
        && optional_field_is(value, "metadata", is_provider_metadata)
}

fn is_v2_tokens(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["input", "output", "reasoning", "cache"], &[])
        && field_is(value, "input", is_finite_number)
        && field_is(value, "output", is_finite_number)
        && field_is(value, "reasoning", is_finite_number)
        && field_is(value, "cache", |cache| {
            has_object_shape(cache, &["read", "write"], &[])
                && field_is(cache, "read", is_finite_number)
                && field_is(cache, "write", is_finite_number)
        })
}

fn is_v2_unknown_error(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["type", "message"], &[])
        && value.get("type").and_then(serde_json::Value::as_str) == Some("unknown")
        && field_is(value, "message", is_string)
}

fn is_v2_retry_error(value: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &["message", "isRetryable"],
        &["statusCode", "responseHeaders", "responseBody", "metadata"],
    ) && field_is(value, "message", is_string)
        && field_is(value, "isRetryable", |value| value.as_bool().is_some())
        && optional_field_is(value, "statusCode", is_finite_number)
        && optional_field_is(value, "responseHeaders", is_string_record)
        && optional_field_is(value, "responseBody", is_string)
        && optional_field_is(value, "metadata", is_string_record)
}

fn is_revert_file_diff(value: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &["path", "status", "additions", "deletions", "patch"],
        &[],
    ) && field_is(value, "path", is_string)
        && matches!(
            value.get("status").and_then(serde_json::Value::as_str),
            Some("added" | "modified" | "deleted")
        )
        && field_is(value, "additions", is_nonnegative_integer)
        && field_is(value, "deletions", is_nonnegative_integer)
        && field_is(value, "patch", is_string)
}

fn is_v2_revert_state(value: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &["messageID"],
        &["partID", "snapshot", "diff", "files"],
    ) && field_is(value, "messageID", |value| {
        value.as_str().is_some_and(valid_v2_message_id)
    }) && optional_field_is(value, "partID", is_string)
        && optional_field_is(value, "snapshot", is_string)
        && optional_field_is(value, "diff", is_string)
        && optional_field_is(value, "files", |files| {
            files
                .as_array()
                .is_some_and(|files| files.iter().all(is_revert_file_diff))
        })
}

fn validate_v2_nested_payload(event_type: &str, data: &serde_json::Value) -> bool {
    field_is(data, "sessionID", |value| {
        value.as_str().is_some_and(valid_session_id)
    }) && match event_type {
        "session.next.agent.switched" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "agent", is_string)
        }
        "session.next.model.switched" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "model", is_model_ref)
        }
        "session.next.moved" => {
            field_is(data, "location", is_v2_location_ref)
                && optional_field_is(data, "subdirectory", is_string)
        }
        "session.next.prompted" | "session.next.prompt.admitted" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "prompt", is_prompt)
                && matches!(
                    data.get("delivery").and_then(serde_json::Value::as_str),
                    Some("steer" | "queue")
                )
        }
        "session.next.context.updated" | "session.next.synthetic" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "text", is_string)
        }
        "session.next.shell.started" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "command", is_string)
        }
        "session.next.shell.ended" => {
            field_is(data, "callID", is_string) && field_is(data, "output", is_string)
        }
        "session.next.step.started" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "agent", is_string)
                && field_is(data, "model", is_model_ref)
                && optional_field_is(data, "snapshot", is_string)
        }
        "session.next.step.ended" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "finish", is_string)
                && field_is(data, "cost", is_finite_number)
                && field_is(data, "tokens", is_v2_tokens)
                && optional_field_is(data, "snapshot", is_string)
                && optional_field_is(data, "files", is_string_array)
        }
        "session.next.step.failed" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "error", is_v2_unknown_error)
        }
        "session.next.text.started" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "textID", is_string)
        }
        "session.next.text.ended" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "textID", is_string)
                && field_is(data, "text", is_string)
        }
        "session.next.tool.input.started" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "name", is_string)
        }
        "session.next.tool.input.ended" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "text", is_string)
        }
        "session.next.tool.called" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "tool", is_string)
                && field_is(data, "input", is_unknown_record)
                && field_is(data, "provider", is_provider_result)
        }
        "session.next.tool.progress" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "structured", is_unknown_record)
                && field_is(data, "content", is_v2_tool_content)
        }
        "session.next.tool.success" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "structured", is_unknown_record)
                && field_is(data, "content", is_v2_tool_content)
                && field_is(data, "provider", is_provider_result)
                && optional_field_is(data, "outputPaths", is_string_array)
        }
        "session.next.tool.failed" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "callID", is_string)
                && field_is(data, "error", is_v2_unknown_error)
                && field_is(data, "provider", is_provider_result)
        }
        "session.next.reasoning.started" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "reasoningID", is_string)
                && optional_field_is(data, "providerMetadata", is_provider_metadata)
        }
        "session.next.reasoning.ended" => {
            field_is(data, "assistantMessageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && field_is(data, "reasoningID", is_string)
                && field_is(data, "text", is_string)
                && optional_field_is(data, "providerMetadata", is_provider_metadata)
        }
        "session.next.retried" => {
            field_is(data, "attempt", is_finite_number)
                && field_is(data, "error", is_v2_retry_error)
        }
        "session.next.compaction.started" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && matches!(
                data.get("reason").and_then(serde_json::Value::as_str),
                Some("auto" | "manual")
            )
        }
        "session.next.compaction.ended" => {
            field_is(data, "messageID", |v| {
                v.as_str().is_some_and(valid_v2_message_id)
            }) && matches!(
                data.get("reason").and_then(serde_json::Value::as_str),
                Some("auto" | "manual")
            ) && field_is(data, "text", is_string)
                && field_is(data, "recent", is_string)
        }
        "session.next.revert.staged" => field_is(data, "revert", is_v2_revert_state),
        "session.next.revert.cleared" => true,
        "session.next.revert.committed" => field_is(data, "messageID", |v| {
            v.as_str().is_some_and(valid_v2_message_id)
        }),
        _ => false,
    }
}

fn apply_v2_projection_event(
    event_type: &str,
    seq: i64,
    session_id: &str,
    data: &serde_json::Value,
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    inputs: &mut BTreeMap<(String, String), ProjectedSessionInput>,
) -> Result<(), OpenCodeImportError> {
    let timestamp = v2_event_timestamp_millis(data)
        .ok_or_else(|| OpenCodeImportError::Blocked("V2 event timestamp is invalid".into()))?;
    match event_type {
        "session.next.agent.switched" => {
            append_event_fields(
                messages,
                session_id,
                seq,
                timestamp,
                data,
                ProjectedEventMessageFields {
                    id_key: "messageID",
                    message_type: "agent-switched",
                    fields: &["agent"],
                },
            )?;
        }
        "session.next.model.switched" => {
            append_event_fields(
                messages,
                session_id,
                seq,
                timestamp,
                data,
                ProjectedEventMessageFields {
                    id_key: "messageID",
                    message_type: "model-switched",
                    fields: &["model"],
                },
            )?;
        }
        "session.next.prompt.admitted" => {
            let id = json_string(data, "messageID")?;
            if messages.contains_key(&(session_id.to_owned(), id.clone()))
                || inputs.contains_key(&(session_id.to_owned(), id.clone()))
            {
                return Err(OpenCodeImportError::Blocked(
                    "a durable prompt admission reused a message ID".into(),
                ));
            }
            inputs.insert(
                (session_id.to_owned(), id.clone()),
                ProjectedSessionInput {
                    session_id: session_id.to_owned(),
                    admitted_seq: seq,
                    promoted_seq: None,
                    time_created: timestamp,
                    delivery: json_string(data, "delivery")?,
                    prompt: required_json(data, "prompt")?.clone(),
                },
            );
        }
        "session.next.prompted" => {
            let id = json_string(data, "messageID")?;
            let prompt = required_json(data, "prompt")?.clone();
            let delivery = json_string(data, "delivery")?;
            match inputs.get_mut(&(session_id.to_owned(), id.clone())) {
                Some(input) => {
                    if input.promoted_seq.is_some()
                        || input.prompt != prompt
                        || input.delivery != delivery
                        || input.time_created != timestamp
                    {
                        return Err(OpenCodeImportError::Blocked(
                            "a prompt promotion does not match its admitted row".into(),
                        ));
                    }
                    input.promoted_seq = Some(seq);
                }
                None => {
                    inputs.insert(
                        (session_id.to_owned(), id.clone()),
                        ProjectedSessionInput {
                            session_id: session_id.to_owned(),
                            admitted_seq: seq,
                            promoted_seq: Some(seq),
                            time_created: timestamp,
                            delivery: delivery.clone(),
                            prompt: prompt.clone(),
                        },
                    );
                }
            }
            let mut projected = serde_json::Map::new();
            projected.insert("text".into(), required_json(&prompt, "text")?.clone());
            for name in ["files", "agents"] {
                if let Some(value) = prompt.get(name) {
                    projected.insert(name.into(), value.clone());
                }
            }
            append_projected_message(messages, session_id, seq, timestamp, &id, "user", projected)?;
        }
        "session.next.context.updated" => {
            append_event_fields(
                messages,
                session_id,
                seq,
                timestamp,
                data,
                ProjectedEventMessageFields {
                    id_key: "messageID",
                    message_type: "system",
                    fields: &["text"],
                },
            )?;
        }
        "session.next.synthetic" => {
            append_event_fields(
                messages,
                session_id,
                seq,
                timestamp,
                data,
                ProjectedEventMessageFields {
                    id_key: "messageID",
                    message_type: "synthetic",
                    fields: &["sessionID", "text"],
                },
            )?;
        }
        "session.next.shell.started" => {
            append_event_fields(
                messages,
                session_id,
                seq,
                timestamp,
                data,
                ProjectedEventMessageFields {
                    id_key: "messageID",
                    message_type: "shell",
                    fields: &["callID", "command"],
                },
            )?;
            let key = (session_id.to_owned(), json_string(data, "messageID")?);
            let row = messages.get_mut(&key).expect("appended shell is present");
            let mut value = row.data.as_object().cloned().unwrap_or_default();
            value.insert("output".into(), "".into());
            row.data = serde_json::Value::Object(value);
        }
        "session.next.shell.ended" => {
            let call_id = json_string(data, "callID")?;
            if let Some(row) = latest_shell(messages, session_id, &call_id) {
                let mut object = row.data.as_object().cloned().unwrap_or_default();
                object.insert("output".into(), required_json(data, "output")?.clone());
                let mut time = object
                    .get("time")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                time.insert("completed".into(), timestamp.into());
                object.insert("time".into(), serde_json::Value::Object(time));
                row.data = serde_json::Value::Object(object);
            }
        }
        "session.next.step.started" => {
            if let Some(row) = latest_incomplete_assistant(messages, session_id) {
                set_message_completed(row, timestamp);
            }
            let id = json_string(data, "assistantMessageID")?;
            let mut projected = serde_json::Map::new();
            projected.insert("agent".into(), required_json(data, "agent")?.clone());
            projected.insert("model".into(), required_json(data, "model")?.clone());
            projected.insert("content".into(), serde_json::Value::Array(Vec::new()));
            if let Some(snapshot) = data.get("snapshot") {
                projected.insert("snapshot".into(), serde_json::json!({"start": snapshot}));
            }
            append_projected_message(
                messages,
                session_id,
                seq,
                timestamp,
                &id,
                "assistant",
                projected,
            )?;
        }
        "session.next.step.ended" => {
            if let Some(row) = assistant_by_id(
                messages,
                session_id,
                &json_string(data, "assistantMessageID")?,
            ) {
                let mut object = row.data.as_object().cloned().unwrap_or_default();
                let mut time = object
                    .get("time")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                time.insert("completed".into(), timestamp.into());
                object.insert("time".into(), serde_json::Value::Object(time));
                for name in ["finish", "cost", "tokens"] {
                    object.insert(name.into(), required_json(data, name)?.clone());
                }
                if data.get("snapshot").is_some() || data.get("files").is_some() {
                    let mut snapshot = object
                        .get("snapshot")
                        .and_then(serde_json::Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    if let Some(value) = data.get("snapshot") {
                        snapshot.insert("end".into(), value.clone());
                    } else {
                        snapshot.remove("end");
                    }
                    if let Some(value) = data.get("files") {
                        snapshot.insert("files".into(), value.clone());
                    } else {
                        snapshot.remove("files");
                    }
                    object.insert("snapshot".into(), serde_json::Value::Object(snapshot));
                }
                row.data = serde_json::Value::Object(object);
            }
        }
        "session.next.step.failed" => {
            if let Some(row) = assistant_by_id(
                messages,
                session_id,
                &json_string(data, "assistantMessageID")?,
            ) {
                let mut object = row.data.as_object().cloned().unwrap_or_default();
                set_completed_fields(&mut object, timestamp);
                object.insert("finish".into(), "error".into());
                object.insert("error".into(), required_json(data, "error")?.clone());
                row.data = serde_json::Value::Object(object);
            }
        }
        "session.next.text.started" => {
            if let Some(row) = assistant_by_id(
                messages,
                session_id,
                &json_string(data, "assistantMessageID")?,
            ) {
                let mut object = row.data.as_object().cloned().unwrap_or_default();
                let mut content = object
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                content.push(
                    serde_json::json!({"type":"text","id":json_string(data,"textID")?,"text":""}),
                );
                object.insert("content".into(), serde_json::Value::Array(content));
                row.data = serde_json::Value::Object(object);
            }
        }
        "session.next.text.ended" => {
            update_assistant_item(messages, session_id, data, "text", "textID", |item| {
                item.insert("text".into(), required_json(data, "text")?.clone());
                Ok(())
            })?;
        }
        "session.next.tool.input.started" => {
            let call_id = json_string(data, "callID")?;
            let mut tool = serde_json::Map::new();
            tool.insert("type".into(), "tool".into());
            tool.insert("id".into(), call_id.into());
            tool.insert("name".into(), required_json(data, "name")?.clone());
            tool.insert("time".into(), serde_json::json!({"created":timestamp}));
            tool.insert(
                "state".into(),
                serde_json::json!({"status":"pending","input":""}),
            );
            update_assistant(messages, session_id, data, |object| {
                let mut content = object
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                content.push(serde_json::Value::Object(tool.clone()));
                object.insert("content".into(), serde_json::Value::Array(content));
                Ok(())
            })?;
        }
        "session.next.tool.input.ended" => {
            update_tool(messages, session_id, data, |tool| {
                if tool
                    .get("state")
                    .and_then(|state| state.get("status"))
                    .and_then(serde_json::Value::as_str)
                    == Some("pending")
                {
                    tool.get_mut("state")
                        .and_then(serde_json::Value::as_object_mut)
                        .expect("pending state object")
                        .insert("input".into(), required_json(data, "text")?.clone());
                }
                Ok(())
            })?;
        }
        "session.next.tool.called" => {
            update_tool(messages, session_id, data, |tool| {
                let mut provider = serde_json::Map::new();
                provider.insert(
                    "executed".into(),
                    required_json(data, "provider")?
                        .get("executed")
                        .cloned()
                        .ok_or_else(|| {
                            OpenCodeImportError::Blocked(
                                "tool provider executed flag missing".into(),
                            )
                        })?,
                );
                if let Some(metadata) = data
                    .get("provider")
                    .and_then(|provider| provider.get("metadata"))
                {
                    provider.insert("metadata".into(), metadata.clone());
                }
                tool.insert("provider".into(), serde_json::Value::Object(provider));
                let mut time = tool
                    .get("time")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                time.insert("ran".into(), timestamp.into());
                tool.insert("time".into(), serde_json::Value::Object(time));
                tool.insert("state".into(), serde_json::json!({"status":"running","input":required_json(data,"input")?,"structured":{},"content":[]}));
                Ok(())
            })?;
        }
        "session.next.tool.progress" => {
            update_tool(messages, session_id, data, |tool| {
                if tool
                    .get("state")
                    .and_then(|state| state.get("status"))
                    .and_then(serde_json::Value::as_str)
                    == Some("running")
                {
                    let state = tool
                        .get_mut("state")
                        .and_then(serde_json::Value::as_object_mut)
                        .expect("running state object");
                    state.insert(
                        "structured".into(),
                        required_json(data, "structured")?.clone(),
                    );
                    state.insert("content".into(), required_json(data, "content")?.clone());
                }
                Ok(())
            })?;
        }
        "session.next.tool.success" => {
            update_tool(messages, session_id, data, |tool| {
                let state = tool
                    .get("state")
                    .and_then(serde_json::Value::as_object)
                    .cloned();
                if state
                    .as_ref()
                    .and_then(|state| state.get("status"))
                    .and_then(serde_json::Value::as_str)
                    != Some("running")
                {
                    return Ok(());
                }
                let running = state.expect("running state object");
                let prior_provider = tool
                    .get("provider")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let event_provider = required_json(data, "provider")?;
                let mut provider = serde_json::Map::new();
                provider.insert(
                    "executed".into(),
                    serde_json::Value::Bool(
                        event_provider
                            .get("executed")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                            || prior_provider
                                .get("executed")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false),
                    ),
                );
                if let Some(value) = prior_provider.get("metadata") {
                    provider.insert("metadata".into(), value.clone());
                }
                if let Some(value) = event_provider.get("metadata") {
                    provider.insert("resultMetadata".into(), value.clone());
                }
                tool.insert("provider".into(), serde_json::Value::Object(provider));
                let mut time = tool
                    .get("time")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                time.insert("completed".into(), timestamp.into());
                tool.insert("time".into(), serde_json::Value::Object(time));
                let mut completed = serde_json::Map::new();
                completed.insert("status".into(), "completed".into());
                completed.insert(
                    "input".into(),
                    running.get("input").cloned().ok_or_else(|| {
                        OpenCodeImportError::Blocked("running tool has no input".into())
                    })?,
                );
                completed.insert(
                    "structured".into(),
                    required_json(data, "structured")?.clone(),
                );
                completed.insert("content".into(), required_json(data, "content")?.clone());
                completed.insert(
                    "outputPaths".into(),
                    data.get("outputPaths")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([])),
                );
                if let Some(result) = data.get("result") {
                    completed.insert("result".into(), result.clone());
                }
                tool.insert("state".into(), serde_json::Value::Object(completed));
                Ok(())
            })?;
        }
        "session.next.tool.failed" => {
            update_tool(messages, session_id, data, |tool| {
                let prior_state = tool
                    .get("state")
                    .and_then(serde_json::Value::as_object)
                    .cloned();
                let prior_status = prior_state
                    .as_ref()
                    .and_then(|state| state.get("status"))
                    .and_then(serde_json::Value::as_str);
                if !matches!(prior_status, Some("pending" | "running")) {
                    return Ok(());
                }
                let prior_provider = tool
                    .get("provider")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let event_provider = required_json(data, "provider")?;
                let mut provider = serde_json::Map::new();
                provider.insert(
                    "executed".into(),
                    serde_json::Value::Bool(
                        event_provider
                            .get("executed")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                            || prior_provider
                                .get("executed")
                                .and_then(serde_json::Value::as_bool)
                                .unwrap_or(false),
                    ),
                );
                if let Some(value) = prior_provider.get("metadata") {
                    provider.insert("metadata".into(), value.clone());
                }
                if let Some(value) = event_provider.get("metadata") {
                    provider.insert("resultMetadata".into(), value.clone());
                }
                tool.insert("provider".into(), serde_json::Value::Object(provider));
                let mut time = tool
                    .get("time")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                time.insert("completed".into(), timestamp.into());
                tool.insert("time".into(), serde_json::Value::Object(time));
                let running = prior_status == Some("running");
                let mut failed = serde_json::Map::new();
                failed.insert("status".into(), "error".into());
                let input = prior_state
                    .as_ref()
                    .and_then(|state| state.get("input"))
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                failed.insert(
                    "input".into(),
                    if running {
                        input
                    } else {
                        serde_json::json!({})
                    },
                );
                failed.insert(
                    "structured".into(),
                    if running {
                        prior_state
                            .as_ref()
                            .and_then(|state| state.get("structured"))
                            .cloned()
                            .unwrap_or(serde_json::json!({}))
                    } else {
                        serde_json::json!({})
                    },
                );
                failed.insert(
                    "content".into(),
                    if running {
                        prior_state
                            .as_ref()
                            .and_then(|state| state.get("content"))
                            .cloned()
                            .unwrap_or(serde_json::json!([]))
                    } else {
                        serde_json::json!([])
                    },
                );
                failed.insert("error".into(), required_json(data, "error")?.clone());
                if let Some(result) = data.get("result") {
                    failed.insert("result".into(), result.clone());
                }
                tool.insert("state".into(), serde_json::Value::Object(failed));
                Ok(())
            })?;
        }
        "session.next.reasoning.started" => {
            let mut item = serde_json::Map::new();
            item.insert("type".into(), "reasoning".into());
            item.insert("id".into(), required_json(data, "reasoningID")?.clone());
            item.insert("text".into(), "".into());
            if let Some(metadata) = data.get("providerMetadata") {
                item.insert("providerMetadata".into(), metadata.clone());
            }
            item.insert("time".into(), serde_json::json!({"created":timestamp}));
            update_assistant(messages, session_id, data, |object| {
                let mut content = object
                    .get("content")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                content.push(serde_json::Value::Object(item.clone()));
                object.insert("content".into(), serde_json::Value::Array(content));
                Ok(())
            })?;
        }
        "session.next.reasoning.ended" => {
            update_assistant_item(
                messages,
                session_id,
                data,
                "reasoning",
                "reasoningID",
                |item| {
                    item.insert("text".into(), required_json(data, "text")?.clone());
                    let created = item
                        .get("time")
                        .and_then(|time| time.get("created"))
                        .cloned()
                        .unwrap_or(timestamp.into());
                    item.insert(
                        "time".into(),
                        serde_json::json!({"created":created,"completed":timestamp}),
                    );
                    if let Some(metadata) = data.get("providerMetadata") {
                        item.insert("providerMetadata".into(), metadata.clone());
                    }
                    Ok(())
                },
            )?;
        }
        "session.next.compaction.ended" => {
            let id = json_string(data, "messageID")?;
            let mut projected = serde_json::Map::new();
            projected.insert("reason".into(), required_json(data, "reason")?.clone());
            projected.insert("summary".into(), required_json(data, "text")?.clone());
            projected.insert("recent".into(), required_json(data, "recent")?.clone());
            append_projected_message(
                messages,
                session_id,
                seq,
                timestamp,
                &id,
                "compaction",
                projected,
            )?;
        }
        "session.next.revert.committed" => {
            let boundary_id = json_string(data, "messageID")?;
            let boundary = messages
                .get(&(session_id.to_owned(), boundary_id.clone()))
                .map(|message| message.seq)
                .ok_or_else(|| {
                    OpenCodeImportError::Blocked("V2 revert boundary message is missing".into())
                })?;
            messages.retain(|(owner, _), message| owner != session_id || message.seq <= boundary);
            inputs.retain(|(owner, _), input| {
                owner != session_id
                    || (input.admitted_seq <= boundary
                        && input
                            .promoted_seq
                            .is_none_or(|promoted| promoted <= boundary))
            });
        }
        // These durable events either have no session-message projection or
        // only carry a stream delta that is intentionally not persisted.
        "session.next.moved"
        | "session.next.retried"
        | "session.next.compaction.started"
        | "session.next.revert.staged"
        | "session.next.revert.cleared" => {}
        _ => {
            return Err(OpenCodeImportError::Blocked(
                "durable V2 event is not replayable by the pinned projector".into(),
            ));
        }
    }
    Ok(())
}

fn required_json<'a>(
    value: &'a serde_json::Value,
    key: &str,
) -> Result<&'a serde_json::Value, OpenCodeImportError> {
    value.get(key).ok_or_else(|| {
        OpenCodeImportError::Blocked(format!("durable event is missing required {key}"))
    })
}

fn append_event_fields(
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    seq: i64,
    timestamp: i64,
    event_data: &serde_json::Value,
    projection: ProjectedEventMessageFields<'_>,
) -> Result<(), OpenCodeImportError> {
    let id = json_string(event_data, projection.id_key)?;
    let mut projected = serde_json::Map::new();
    for field in projection.fields {
        if let Some(value) = event_data.get(*field) {
            projected.insert((*field).to_owned(), value.clone());
        }
    }
    append_projected_message(
        messages,
        session_id,
        seq,
        timestamp,
        &id,
        projection.message_type,
        projected,
    )
}

struct ProjectedEventMessageFields<'a> {
    id_key: &'a str,
    message_type: &'a str,
    fields: &'a [&'a str],
}

fn append_projected_message(
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    seq: i64,
    timestamp: i64,
    id: &str,
    message_type: &str,
    mut projected: serde_json::Map<String, serde_json::Value>,
) -> Result<(), OpenCodeImportError> {
    if messages.contains_key(&(session_id.to_owned(), id.to_owned())) {
        return Err(OpenCodeImportError::Blocked(
            "a durable V2 event reused a session message ID".into(),
        ));
    }
    let mut time = serde_json::Map::new();
    time.insert("created".into(), timestamp.into());
    projected.insert("time".into(), serde_json::Value::Object(time));
    messages.insert(
        (session_id.to_owned(), id.to_owned()),
        ProjectedSessionMessage {
            message_type: message_type.to_owned(),
            seq,
            time_created: timestamp,
            data: serde_json::Value::Object(projected),
        },
    );
    Ok(())
}

fn json_string(value: &serde_json::Value, key: &str) -> Result<String, OpenCodeImportError> {
    required_json(value, key)?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| OpenCodeImportError::Blocked(format!("durable event has invalid {key}")))
}

fn latest_incomplete_assistant<'a>(
    messages: &'a mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
) -> Option<&'a mut ProjectedSessionMessage> {
    let key = messages
        .iter()
        .filter(|((owner, _), message)| {
            owner == session_id
                && message.message_type == "assistant"
                && message
                    .data
                    .get("time")
                    .and_then(|time| time.get("completed"))
                    .is_none()
        })
        .max_by_key(|(_, message)| message.seq)
        .map(|(key, _)| key.clone())?;
    messages.get_mut(&key)
}

fn latest_shell<'a>(
    messages: &'a mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    call_id: &str,
) -> Option<&'a mut ProjectedSessionMessage> {
    let key = messages
        .iter()
        .filter(|((owner, _), message)| {
            owner == session_id
                && message.message_type == "shell"
                && message
                    .data
                    .get("callID")
                    .and_then(serde_json::Value::as_str)
                    == Some(call_id)
        })
        .max_by_key(|(_, message)| message.seq)
        .map(|(key, _)| key.clone())?;
    messages.get_mut(&key)
}

fn assistant_by_id<'a>(
    messages: &'a mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    id: &str,
) -> Option<&'a mut ProjectedSessionMessage> {
    let row = messages.get_mut(&(session_id.to_owned(), id.to_owned()))?;
    (row.message_type == "assistant").then_some(row)
}

fn set_message_completed(row: &mut ProjectedSessionMessage, timestamp: i64) {
    let mut object = row.data.as_object().cloned().unwrap_or_default();
    set_completed_fields(&mut object, timestamp);
    row.data = serde_json::Value::Object(object);
}

fn set_completed_fields(object: &mut serde_json::Map<String, serde_json::Value>, timestamp: i64) {
    let mut time = object
        .get("time")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    time.insert("completed".into(), timestamp.into());
    object.insert("time".into(), serde_json::Value::Object(time));
}

fn update_assistant(
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    event_data: &serde_json::Value,
    update: impl FnOnce(
        &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), OpenCodeImportError>,
) -> Result<(), OpenCodeImportError> {
    let id = json_string(event_data, "assistantMessageID")?;
    if let Some(row) = assistant_by_id(messages, session_id, &id) {
        let mut object = row.data.as_object().cloned().unwrap_or_default();
        update(&mut object)?;
        row.data = serde_json::Value::Object(object);
    }
    Ok(())
}

fn update_tool(
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    event_data: &serde_json::Value,
    update: impl FnOnce(
        &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), OpenCodeImportError>,
) -> Result<(), OpenCodeImportError> {
    update_assistant_item(messages, session_id, event_data, "tool", "callID", update)
}

struct TodowriteProjection {
    todos: serde_json::Value,
    called_at: i64,
    succeeded_at: i64,
}

fn latest_successful_todowrite(
    events: &[SerializedRow],
    session_id: &str,
) -> Result<TodowriteProjection, OpenCodeImportError> {
    let mut calls = BTreeMap::<(String, String), (i64, i64, serde_json::Value)>::new();
    let mut successes = Vec::<(i64, i64, (i64, i64, serde_json::Value))>::new();
    for event in events {
        let event_type = value_text(event, "type")?.unwrap_or_default();
        let Some(kind) = pinned_event_kind(&event_type) else {
            continue;
        };
        if !matches!(
            kind,
            "session.next.tool.called" | "session.next.tool.success"
        ) {
            continue;
        }
        let data = parse_event_data(event)?;
        if data.get("sessionID").and_then(serde_json::Value::as_str) != Some(session_id) {
            continue;
        }
        let Some(assistant_id) = data
            .get("assistantMessageID")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(call_id) = data.get("callID").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let seq = value_integer_required(event, "seq")?;
        let timestamp = v2_event_timestamp_millis(&data).ok_or_else(|| {
            OpenCodeImportError::Blocked("todowrite event has no valid DateTime timestamp".into())
        })?;
        if kind == "session.next.tool.called" {
            if data.get("tool").and_then(serde_json::Value::as_str) == Some("todowrite") {
                let todos = data
                    .get("input")
                    .and_then(|input| input.get("todos"))
                    .cloned()
                    .ok_or_else(|| {
                        OpenCodeImportError::Blocked(
                            "todowrite event has no exact todo input".into(),
                        )
                    })?;
                calls.insert(
                    (assistant_id.into(), call_id.into()),
                    (seq, timestamp, todos),
                );
            }
        } else if let Some((called_seq, called_at, todos)) =
            calls.get(&(assistant_id.into(), call_id.into()))
        {
            if seq <= *called_seq {
                continue;
            }
            successes.push((*called_seq, *called_at, (seq, timestamp, todos.clone())));
        }
    }
    let (_, called_at, (succeeded_seq, succeeded_at, todos)) = successes
        .into_iter()
        .max_by_key(|(_, _, (seq, _, _))| *seq)
        .ok_or_else(|| {
            OpenCodeImportError::Blocked(
                "changed todo rows have no durable successful todowrite event pair".into(),
            )
        })?;
    let _ = succeeded_seq;
    Ok(TodowriteProjection {
        todos,
        called_at,
        succeeded_at,
    })
}

fn todo_timestamps_match_call(row: &SerializedRow, called_at: i64, succeeded_at: i64) -> bool {
    let Some(created) = value_integer(row, "time_created") else {
        return false;
    };
    let Some(updated) = value_integer(row, "time_updated") else {
        return false;
    };
    created >= called_at && created <= succeeded_at && updated >= created && updated <= succeeded_at
}

fn parse_event_data(row: &SerializedRow) -> Result<serde_json::Value, OpenCodeImportError> {
    let data = value_text(row, "data")?.ok_or_else(|| {
        OpenCodeImportError::Blocked("provider transition event has no payload".into())
    })?;
    serde_json::from_str(&data).map_err(|_| {
        OpenCodeImportError::Blocked("provider transition event payload is malformed".into())
    })
}

fn baseline_row_change_is_typed(
    baseline: &freshell_sessions::opencode_transfer::RowDigest,
    current: &SerializedRow,
) -> Result<bool, OpenCodeImportError> {
    if baseline.column_sha256.is_empty() {
        // Legacy manifests can prove exact equality only. Unknown old rows are
        // never upgraded into transition-capable evidence.
        return Ok(false);
    }
    let (columns, json_nodes) = current_row_field_digests(current)?;
    if columns.len() != baseline.column_sha256.len() {
        return Ok(false);
    }
    for (column, old_digest) in &baseline.column_sha256 {
        let Some(new_digest) = columns.get(column) else {
            return Ok(false);
        };
        if old_digest == new_digest {
            continue;
        }
        if current.table == "session" && allowed_scalar_column("session", column) {
            // Session.Info commits the complete scalar/JSON column below,
            // including a native NULL -> model object or cleared revert.
        } else if baseline
            .json_node_sha256
            .keys()
            .any(|path| path.starts_with(&format!("{column}#")))
            || json_nodes
                .keys()
                .any(|path| path.starts_with(&format!("{column}#")))
        {
            if !json_column_changes_are_typed(
                current.table.as_str(),
                column,
                &baseline.json_node_sha256,
                &json_nodes,
            ) {
                return Ok(false);
            }
        } else if !allowed_scalar_column(current.table.as_str(), column) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn current_row_field_digests(
    row: &SerializedRow,
) -> Result<CurrentRowFieldDigests, OpenCodeImportError> {
    let columns = row
        .values
        .iter()
        .map(|(name, value)| {
            serde_json::to_vec(value)
                .map(|bytes| (name.clone(), sha256(&bytes)))
                .map_err(|_| OpenCodeImportError::Metadata("native row digest failed".into()))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let mut json_nodes = BTreeMap::new();
    for (column, value) in &row.values {
        let SerializedSqlValue::Text { value } = value else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(value) else {
            continue;
        };
        collect_current_json_nodes(column, &json, "", &mut json_nodes)?;
    }
    Ok((columns, json_nodes))
}

fn collect_current_json_nodes(
    column: &str,
    value: &serde_json::Value,
    pointer: &str,
    output: &mut BTreeMap<String, String>,
) -> Result<(), OpenCodeImportError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| OpenCodeImportError::Metadata("native JSON digest failed".into()))?;
    output.insert(format!("{column}#{pointer}"), sha256(&bytes));
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                collect_current_json_nodes(column, child, &format!("{pointer}/{escaped}"), output)?;
            }
        }
        serde_json::Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                collect_current_json_nodes(column, child, &format!("{pointer}/{index}"), output)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn update_assistant_item(
    messages: &mut BTreeMap<(String, String), ProjectedSessionMessage>,
    session_id: &str,
    event_data: &serde_json::Value,
    item_type: &str,
    id_field: &str,
    update: impl FnOnce(
        &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), OpenCodeImportError>,
) -> Result<(), OpenCodeImportError> {
    let id = json_string(event_data, id_field)?;
    update_assistant(messages, session_id, event_data, |object| {
        if let Some(item) = object
            .get_mut("content")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|content| {
                content.iter_mut().rev().find(|item| {
                    item.get("type").and_then(serde_json::Value::as_str) == Some(item_type)
                        && item.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())
                })
            })
            .and_then(serde_json::Value::as_object_mut)
        {
            update(item)?;
        }
        Ok(())
    })
}

fn json_column_changes_are_typed(
    table: &str,
    column: &str,
    baseline: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) -> bool {
    let prefix = format!("{column}#");
    let old = baseline
        .iter()
        .filter(|(path, _)| path.starts_with(&prefix))
        .collect::<BTreeMap<_, _>>();
    let new = current
        .iter()
        .filter(|(path, _)| path.starts_with(&prefix))
        .collect::<BTreeMap<_, _>>();
    if old.is_empty() || new.is_empty() {
        return false;
    }
    let paths = old
        .keys()
        .chain(new.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    paths.into_iter().all(|path| {
        if old.get(path) == new.get(path) {
            return true;
        }
        let pointer = path.strip_prefix(&prefix).unwrap_or_default();
        if allowed_json_node(table, column, pointer) {
            return true;
        }
        // A parent node hash changes when an allowed child changes. Inspect
        // the child path separately; a newly-added/deleted parent is blocked.
        let allowed_descendant = allowed_json_prefixes(table, column)
            .iter()
            .any(|allowed| allowed.starts_with(&format!("{pointer}/")));
        allowed_descendant && old.contains_key(path) && new.contains_key(path)
    })
}

fn allowed_scalar_column(table: &str, column: &str) -> bool {
    match table {
        "event_sequence" => column == "seq",
        "session" => matches!(
            column,
            "title"
                | "summary_additions"
                | "summary_deletions"
                | "summary_files"
                | "summary_diffs"
                | "cost"
                | "tokens_input"
                | "tokens_output"
                | "tokens_reasoning"
                | "tokens_cache_read"
                | "tokens_cache_write"
                | "time_updated"
                | "time_compacting"
                | "time_archived"
                | "permission"
                | "agent"
                | "model"
                | "revert"
                | "directory"
                | "path"
                | "workspace_id"
        ),
        "message" => column == "data",
        "part" => column == "data",
        "session_input" => matches!(column, "delivery" | "promoted_seq"),
        _ => false,
    }
}

fn allowed_json_prefixes(table: &str, column: &str) -> Vec<String> {
    let paths: &[&str] = match (table, column) {
        ("message", "data") => &[
            "/time/completed",
            "/cost",
            "/tokens/input",
            "/tokens/output",
            "/tokens/reasoning",
            "/tokens/cache/read",
            "/tokens/cache/write",
            "/status",
        ],
        ("part", "data") => &[
            "/state/status",
            "/state/time",
            "/state/output",
            "/state/error",
            "/state/title",
            "/state/metadata",
        ],
        _ => &[],
    };
    paths.iter().map(|path| (*path).to_string()).collect()
}

fn allowed_json_node(table: &str, column: &str, pointer: &str) -> bool {
    allowed_json_prefixes(table, column).iter().any(|allowed| {
        *allowed == pointer || *allowed == "/" || pointer.starts_with(&format!("{allowed}/"))
    })
}

fn row_has_supporting_transition(
    row: &SerializedRow,
    events: &[SerializedRow],
) -> Result<bool, OpenCodeImportError> {
    let id = value_text(row, "id")?;
    let session_id = if row.table == "session" {
        let Some(id) = id.clone() else {
            return Ok(false);
        };
        id
    } else {
        match value_text(row, "session_id")? {
            Some(value) => value,
            None => match value_text(row, "aggregate_id")? {
                Some(value) => value,
                None => return Ok(false),
            },
        }
    };
    for event in events {
        let Some(raw_event_type) = value_text(event, "type")? else {
            continue;
        };
        let Some(data) = value_text(event, "data")? else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let Some(event_type) = pinned_event_kind(&raw_event_type) else {
            continue;
        };
        if data.get("sessionID").and_then(serde_json::Value::as_str) != Some(&session_id) {
            continue;
        }
        let bound = match row.table.as_str() {
            "message" => {
                event_type == "message.updated"
                    && id
                        .as_deref()
                        .is_some_and(|id| message_event_matches_row(&data, row, id))
                    && event_is_latest_for_entity(
                        event,
                        events,
                        event_type,
                        &session_id,
                        id.as_deref().unwrap_or_default(),
                    )?
            }
            "part" => {
                event_type == "message.part.updated"
                    && id
                        .as_deref()
                        .is_some_and(|id| part_event_matches_row(&data, row, id))
                    && event_is_latest_for_entity(
                        event,
                        events,
                        event_type,
                        &session_id,
                        id.as_deref().unwrap_or_default(),
                    )?
                    && part_creation_event_matches(row, events)?
                    && sql_number(row, "time_created")
                        .zip(sql_number(row, "time_updated"))
                        .is_some_and(|(created, updated)| {
                            compare_sql_numbers(updated, created) != Ordering::Less
                        })
            }
            "session" => match event_type {
                "session.created" | "session.updated" => {
                    id.as_deref().is_some_and(|id| {
                        data.get("info").is_some_and(|info| {
                            info.get("id").and_then(serde_json::Value::as_str) == Some(id)
                                && session_row_matches_info(row, info)
                        })
                    }) && session_snapshot_event_is_current(event, events, &session_id)?
                }
                "session.next.revert.staged" => id.as_deref().is_some_and(|id| {
                    value_text(row, "id").ok().flatten().as_deref() == Some(id)
                        && json_column(row, "revert").as_ref() == data.get("revert")
                        && v2_event_timestamp_millis(&data) == value_integer(row, "time_updated")
                }),
                "session.next.revert.cleared" | "session.next.revert.committed" => {
                    id.as_deref().is_some_and(|id| {
                        value_text(row, "id").ok().flatten().as_deref() == Some(id)
                            && json_column(row, "revert") == Some(serde_json::Value::Null)
                            && v2_event_timestamp_millis(&data)
                                == value_integer(row, "time_updated")
                    })
                }
                "session.next.agent.switched" => {
                    id.as_deref() == Some(session_id.as_str())
                        && value_text(row, "agent")?.as_deref()
                            == data.get("agent").and_then(serde_json::Value::as_str)
                        && v2_event_timestamp_millis(&data) == value_integer(row, "time_updated")
                }
                "session.next.model.switched" => {
                    id.as_deref() == Some(session_id.as_str())
                        && json_column(row, "model") == data.get("model").cloned()
                        && v2_event_timestamp_millis(&data) == value_integer(row, "time_updated")
                }
                "session.next.moved" => {
                    let location = data.get("location");
                    id.as_deref() == Some(session_id.as_str())
                        && value_text(row, "directory")?.as_deref()
                            == location
                                .and_then(|value| value.get("directory"))
                                .and_then(serde_json::Value::as_str)
                        && value_text(row, "path")?.as_deref()
                            == data.get("subdirectory").and_then(serde_json::Value::as_str)
                        && value_text(row, "workspace_id")?.as_deref()
                            == location
                                .and_then(|value| value.get("workspaceID"))
                                .and_then(serde_json::Value::as_str)
                        && v2_event_timestamp_millis(&data) == value_integer(row, "time_updated")
                }
                _ => false,
            },
            "session_input" => session_input_event_matches_row(&data, event, row, event_type),
            // These projections have no complete row-value witness in the
            // pinned durable-event schema, so a generic entity-ID match is
            // never sufficient evidence for their mutation.
            "session_message" | "session_context_epoch" | "todo" => false,
            _ => false,
        };
        if bound {
            return Ok(true);
        }
    }
    Ok(false)
}

fn event_is_latest_for_entity(
    candidate: &SerializedRow,
    events: &[SerializedRow],
    event_type: &str,
    session_id: &str,
    entity_id: &str,
) -> Result<bool, OpenCodeImportError> {
    let candidate_seq = value_integer_required(candidate, "seq")?;
    for event in events {
        if event.table != "event"
            || value_integer(event, "seq").is_none_or(|seq| seq <= candidate_seq)
            || pinned_event_kind(&value_text(event, "type")?.unwrap_or_default())
                != Some(event_type)
        {
            continue;
        }
        let data = parse_event_data(event)?;
        if data.get("sessionID").and_then(serde_json::Value::as_str) != Some(session_id) {
            continue;
        }
        let same_entity = match event_type {
            "message.updated" => {
                data.get("info")
                    .and_then(|info| info.get("id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(entity_id)
            }
            "message.part.updated" => {
                data.get("part")
                    .and_then(|part| part.get("id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(entity_id)
            }
            _ => false,
        };
        if same_entity {
            return Ok(false);
        }
    }
    Ok(true)
}

fn session_snapshot_event_is_current(
    candidate: &SerializedRow,
    events: &[SerializedRow],
    session_id: &str,
) -> Result<bool, OpenCodeImportError> {
    let candidate_seq = value_integer_required(candidate, "seq")?;
    for event in events {
        if event.table != "event"
            || value_integer(event, "seq").is_none_or(|seq| seq <= candidate_seq)
        {
            continue;
        }
        let Some(event_session) = value_text(event, "aggregate_id")? else {
            continue;
        };
        if event_session != session_id {
            continue;
        }
        let raw_event_type = value_text(event, "type")?.unwrap_or_default();
        let event_type = pinned_event_kind(&raw_event_type);
        if matches!(
            event_type,
            Some(
                "session.updated"
                    | "session.next.agent.switched"
                    | "session.next.model.switched"
                    | "session.next.moved"
            )
        ) {
            return Ok(false);
        }
        if event_type == Some("message.part.updated") {
            let data = parse_event_data(event)?;
            if data
                .get("part")
                .and_then(|part| part.get("type"))
                .and_then(serde_json::Value::as_str)
                == Some("step-finish")
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn pinned_event_kind(raw_type: &str) -> Option<&str> {
    const PINNED_DURABLE_EVENT_TYPES: &[&str] = &[
        "session.created.1",
        "session.updated.1",
        "session.deleted.1",
        "message.updated.1",
        "message.removed.1",
        "message.part.updated.1",
        "message.part.removed.1",
        "session.next.agent.switched.1",
        "session.next.model.switched.1",
        "session.next.moved.1",
        "session.next.prompted.1",
        "session.next.prompt.admitted.1",
        "session.next.context.updated.1",
        "session.next.synthetic.1",
        "session.next.shell.started.1",
        "session.next.shell.ended.1",
        "session.next.step.started.1",
        "session.next.step.ended.2",
        "session.next.step.failed.2",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.tool.input.started.1",
        "session.next.tool.input.ended.1",
        "session.next.tool.called.1",
        "session.next.tool.progress.1",
        "session.next.tool.success.1",
        "session.next.tool.failed.1",
        "session.next.reasoning.started.1",
        "session.next.reasoning.ended.1",
        "session.next.retried.1",
        "session.next.compaction.started.1",
        "session.next.compaction.ended.1",
        "session.next.revert.staged.1",
        "session.next.revert.cleared.1",
        "session.next.revert.committed.1",
    ];
    if PINNED_DURABLE_EVENT_TYPES.contains(&raw_type) {
        raw_type.rsplit_once('.').map(|(kind, _)| kind)
    } else {
        None
    }
}

fn value_integer(row: &SerializedRow, key: &str) -> Option<i64> {
    match row.values.get(key) {
        Some(SerializedSqlValue::Integer { value }) => Some(*value),
        _ => None,
    }
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

fn sql_number_matches_json(row: &SerializedRow, key: &str, value: &serde_json::Value) -> bool {
    let (Some(actual), Some(expected)) = (sql_number(row, key), value.as_number()) else {
        return false;
    };
    match actual {
        SqlNumber::Integer(actual) => json_number_matches_integer(expected, actual),
        SqlNumber::Real(actual) => json_number_as_exact_f64(expected) == Some(actual),
    }
}

fn json_number_matches_integer(number: &serde_json::Number, integer: i64) -> bool {
    if let Some(expected) = number.as_i64() {
        return integer == expected;
    }
    if let Some(expected) = number.as_u64() {
        return integer >= 0 && integer as u64 == expected;
    }
    number.as_f64().and_then(exact_f64_as_i64) == Some(integer)
}

fn json_number_as_exact_f64(number: &serde_json::Number) -> Option<f64> {
    if let Some(integer) = number.as_i64() {
        let value = integer as f64;
        return (exact_f64_as_i64(value) == Some(integer)).then_some(value);
    }
    if let Some(integer) = number.as_u64() {
        let value = integer as f64;
        return (exact_f64_as_u64(value) == Some(integer)).then_some(value);
    }
    number.as_f64().filter(|value| value.is_finite())
}

fn exact_f64_as_i64(value: f64) -> Option<i64> {
    const I64_UPPER_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;
    if !value.is_finite()
        || value.fract() != 0.0
        || value < i64::MIN as f64
        || value >= I64_UPPER_EXCLUSIVE
    {
        return None;
    }
    let integer = value as i64;
    (integer as f64 == value).then_some(integer)
}

fn exact_f64_as_u64(value: f64) -> Option<u64> {
    const U64_UPPER_EXCLUSIVE: f64 = 18_446_744_073_709_551_616.0;
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..U64_UPPER_EXCLUSIVE).contains(&value) {
        return None;
    }
    let integer = value as u64;
    (integer as f64 == value).then_some(integer)
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

fn json_column(row: &SerializedRow, column: &str) -> Option<serde_json::Value> {
    match row.values.get(column)? {
        SerializedSqlValue::Null => Some(serde_json::Value::Null),
        SerializedSqlValue::Text { value } => serde_json::from_str(value).ok(),
        _ => None,
    }
}

fn message_event_matches_row(data: &serde_json::Value, row: &SerializedRow, id: &str) -> bool {
    let Some(info) = data.get("info").and_then(serde_json::Value::as_object) else {
        return false;
    };
    if info.get("id").and_then(serde_json::Value::as_str) != Some(id)
        || info.get("sessionID").and_then(serde_json::Value::as_str)
            != value_text(row, "session_id").ok().flatten().as_deref()
    {
        return false;
    }
    let mut expected = info.clone();
    expected.remove("id");
    expected.remove("sessionID");
    let Some(actual) = json_column(row, "data") else {
        return false;
    };
    let Some(created) = info.get("time").and_then(|time| time.get("created")) else {
        return false;
    };
    actual == serde_json::Value::Object(expected)
        && sql_number_matches_json(row, "time_created", created)
}

fn part_event_matches_row(data: &serde_json::Value, row: &SerializedRow, id: &str) -> bool {
    let Some(part) = data.get("part").and_then(serde_json::Value::as_object) else {
        return false;
    };
    if part.get("id").and_then(serde_json::Value::as_str) != Some(id)
        || part.get("sessionID").and_then(serde_json::Value::as_str)
            != value_text(row, "session_id").ok().flatten().as_deref()
        || part.get("messageID").and_then(serde_json::Value::as_str)
            != value_text(row, "message_id").ok().flatten().as_deref()
    {
        return false;
    }
    let mut expected = part.clone();
    expected.remove("id");
    expected.remove("sessionID");
    expected.remove("messageID");
    json_column(row, "data") == Some(serde_json::Value::Object(expected))
}

fn part_creation_event_matches(
    row: &SerializedRow,
    events: &[SerializedRow],
) -> Result<bool, OpenCodeImportError> {
    let Some(part_id) = value_text(row, "id")? else {
        return Ok(false);
    };
    let Some(session_id) = value_text(row, "session_id")? else {
        return Ok(false);
    };
    let mut first: Option<(i64, serde_json::Value)> = None;
    for event in events {
        let event_type = value_text(event, "type")?.unwrap_or_default();
        if pinned_event_kind(&event_type) != Some("message.part.updated") {
            continue;
        }
        let data = parse_event_data(event)?;
        let Some(part) = data.get("part") else {
            continue;
        };
        if part.get("id").and_then(serde_json::Value::as_str) != Some(part_id.as_str())
            || part.get("sessionID").and_then(serde_json::Value::as_str)
                != Some(session_id.as_str())
        {
            continue;
        }
        let seq = value_integer_required(event, "seq")?;
        let time = data
            .get("time")
            .filter(|value| value.as_f64().is_some_and(f64::is_finite))
            .cloned()
            .ok_or_else(|| {
                OpenCodeImportError::Blocked("durable part update has no finite timestamp".into())
            })?;
        if first.as_ref().is_none_or(|(first_seq, _)| seq < *first_seq) {
            first = Some((seq, time));
        }
    }
    Ok(first.is_some_and(|(_, time)| sql_number_matches_json(row, "time_created", &time)))
}

fn session_row_matches_info(row: &SerializedRow, info: &serde_json::Value) -> bool {
    const COLUMNS: &[&str] = &[
        "id",
        "project_id",
        "workspace_id",
        "parent_id",
        "slug",
        "directory",
        "path",
        "title",
        "version",
        "share_url",
        "summary_additions",
        "summary_deletions",
        "summary_files",
        "summary_diffs",
        "metadata",
        "cost",
        "tokens_input",
        "tokens_output",
        "tokens_reasoning",
        "tokens_cache_read",
        "tokens_cache_write",
        "revert",
        "permission",
        "agent",
        "model",
        "time_created",
        "time_updated",
        "time_compacting",
        "time_archived",
    ];
    COLUMNS.iter().all(|column| {
        let Some(actual) = sql_column_as_json(row, column) else {
            return false;
        };
        let expected = session_info_column(info, column);
        if actual.is_number() && expected.is_number() {
            sql_number_matches_json(row, column, &expected)
        } else {
            actual == expected
        }
    })
}

fn sql_column_as_json(row: &SerializedRow, column: &str) -> Option<serde_json::Value> {
    match row.values.get(column)? {
        SerializedSqlValue::Null => Some(serde_json::Value::Null),
        SerializedSqlValue::Integer { value } => Some((*value).into()),
        SerializedSqlValue::Real { bits } => {
            let bits = u64::from_str_radix(bits, 16).ok()?;
            serde_json::Number::from_f64(f64::from_bits(bits)).map(serde_json::Value::Number)
        }
        SerializedSqlValue::Text { value } => {
            if matches!(
                column,
                "summary_diffs" | "metadata" | "revert" | "permission" | "model"
            ) {
                serde_json::from_str(value).ok()
            } else {
                Some(serde_json::Value::String(value.clone()))
            }
        }
        SerializedSqlValue::Blob { .. } => None,
    }
}

fn session_info_column(info: &serde_json::Value, column: &str) -> serde_json::Value {
    let null = serde_json::Value::Null;
    let direct = |name: &str| info.get(name).cloned().unwrap_or(serde_json::Value::Null);
    let nested = |object: &str, name: &str| {
        info.get(object)
            .and_then(|value| value.get(name))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let summary = |name: &str| nested("summary", name);
    let tokens = |name: &str| nested("tokens", name);
    match column {
        "id" => direct("id"),
        "project_id" => direct("projectID"),
        "workspace_id" => direct("workspaceID"),
        "parent_id" => direct("parentID"),
        "slug" => direct("slug"),
        "directory" => direct("directory"),
        "path" => direct("path"),
        "title" => direct("title"),
        "version" => direct("version"),
        "share_url" => nested("share", "url"),
        "summary_additions" => summary("additions"),
        "summary_deletions" => summary("deletions"),
        "summary_files" => summary("files"),
        "summary_diffs" => summary("diffs"),
        "metadata" => direct("metadata"),
        "cost" => info.get("cost").cloned().unwrap_or_else(|| 0.into()),
        "tokens_input" => tokens("input"),
        "tokens_output" => tokens("output"),
        "tokens_reasoning" => tokens("reasoning"),
        "tokens_cache_read" => nested("tokens", "cache")
            .get("read")
            .cloned()
            .unwrap_or(null),
        "tokens_cache_write" => nested("tokens", "cache")
            .get("write")
            .cloned()
            .unwrap_or(null),
        "revert" => direct("revert"),
        "permission" => direct("permission"),
        "agent" => direct("agent"),
        "model" => direct("model"),
        "time_created" => nested("time", "created"),
        "time_updated" => nested("time", "updated"),
        "time_compacting" => nested("time", "compacting"),
        "time_archived" => nested("time", "archived"),
        _ => null,
    }
}

fn session_input_event_matches_row(
    data: &serde_json::Value,
    event: &SerializedRow,
    row: &SerializedRow,
    event_type: &str,
) -> bool {
    let Some(id) = data.get("messageID").and_then(serde_json::Value::as_str) else {
        return false;
    };
    if value_text(row, "id").ok().flatten().as_deref() != Some(id)
        || value_text(row, "session_id").ok().flatten().as_deref()
            != data.get("sessionID").and_then(serde_json::Value::as_str)
        || json_column(row, "prompt") != data.get("prompt").cloned()
        || value_text(row, "delivery").ok().flatten().as_deref()
            != data.get("delivery").and_then(serde_json::Value::as_str)
    {
        return false;
    }
    let Some(seq) = value_integer(event, "seq") else {
        return false;
    };
    let Some(timestamp) = v2_event_timestamp_millis(data) else {
        return false;
    };
    match event_type {
        "session.next.prompt.admitted" => {
            value_integer(row, "admitted_seq") == Some(seq)
                && value_integer(row, "time_created") == Some(timestamp)
                && row.values.get("promoted_seq") == Some(&SerializedSqlValue::Null)
        }
        "session.next.prompted" => value_integer(row, "promoted_seq") == Some(seq),
        _ => false,
    }
}

fn verify_current_event_chains(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    events: &[SerializedRow],
) -> Result<(), OpenCodeImportError> {
    let baseline = manifest
        .rows
        .iter()
        .filter(|row| row.table == "event")
        .map(|row| (row.table.clone(), row.key.clone()))
        .collect::<BTreeSet<_>>();
    let mut baseline_cursors = BTreeMap::new();
    for row in manifest
        .rows
        .iter()
        .filter(|row| row.table == "event_sequence")
    {
        let aggregate_id = key_text(&row.key)?;
        baseline_cursors.insert(aggregate_id, row.transition_cursor.unwrap_or(-1));
    }
    let mut events_by_session = BTreeMap::<String, Vec<(i64, &SerializedRow)>>::new();
    for event in events {
        let aggregate_id = value_text(event, "aggregate_id")?.ok_or_else(|| {
            OpenCodeImportError::Blocked("provider event has no exact session aggregate".into())
        })?;
        let seq = value_integer_required(event, "seq")?;
        let raw_event_type = value_text(event, "type")?.unwrap_or_default();
        let Some(event_type) = pinned_event_kind(&raw_event_type) else {
            return Err(OpenCodeImportError::Blocked(
                "provider event type is not in the pinned durable manifest".into(),
            ));
        };
        let parsed = parse_event_data(event)?;
        if parsed.get("sessionID").and_then(serde_json::Value::as_str)
            != Some(aggregate_id.as_str())
        {
            return Err(OpenCodeImportError::Blocked(
                "provider event is not bound to its session aggregate".into(),
            ));
        }
        if event_type.starts_with("session.next.") {
            validate_v2_event_payload(event_type, &parsed, &aggregate_id)?;
        } else {
            validate_v1_event_envelope(event_type, &parsed)?;
        }
        if baseline.contains(&(event.table.clone(), event.key.clone())) {
            continue;
        }
        if event_type == "session.deleted" {
            return Err(OpenCodeImportError::Blocked(
                "provider session deletion events are unsupported during current-store adoption"
                    .into(),
            ));
        }
        events_by_session
            .entry(aggregate_id)
            .or_default()
            .push((seq, event));
    }
    for (session_id, (table, key)) in current_rows
        .keys()
        .filter(|(table, _)| table == "event_sequence")
        .map(|(table, key)| (key_text(key).unwrap_or_default(), (table, key)))
    {
        let row = current_rows
            .get(&(table.clone(), key.clone()))
            .ok_or_else(|| {
                OpenCodeImportError::Blocked("provider event sequence disappeared".into())
            })?;
        let current_cursor = value_integer_required(row, "seq")?;
        let base_cursor = baseline_cursors.get(&session_id).copied().unwrap_or(-1);
        if current_cursor < base_cursor {
            return Err(OpenCodeImportError::Blocked(
                "provider event sequence moved behind the immutable baseline".into(),
            ));
        }
        let mut session_events = events_by_session.remove(&session_id).unwrap_or_default();
        session_events.sort_by_key(|(seq, _)| *seq);
        let expected_count = i128::from(current_cursor) - i128::from(base_cursor);
        if expected_count < 0 || expected_count as u128 != session_events.len() as u128 {
            return Err(OpenCodeImportError::Blocked(
                "provider transition event sequence has a gap or was reused".into(),
            ));
        }
        for (index, (actual_seq, _)) in session_events.iter().enumerate() {
            let expected_seq = i128::from(base_cursor) + index as i128 + 1;
            if i128::from(*actual_seq) != expected_seq {
                return Err(OpenCodeImportError::Blocked(
                    "provider transition event sequence has a gap or was reused".into(),
                ));
            }
        }
    }
    if !events_by_session.is_empty() {
        return Err(OpenCodeImportError::Blocked(
            "provider transition events have no matching sequence row".into(),
        ));
    }
    let _ = manifest;
    Ok(())
}

fn validate_v1_event_envelope(
    event_type: &str,
    data: &serde_json::Value,
) -> Result<(), OpenCodeImportError> {
    let (required_keys, optional_keys): (&[&str], &[&str]) = match event_type {
        "session.created" | "session.updated" | "session.deleted" | "message.updated" => {
            (&["sessionID", "info"], &[])
        }
        "message.removed" => (&["sessionID", "messageID"], &[]),
        "message.part.removed" => (&["sessionID", "messageID", "partID"], &[]),
        "message.part.updated" => (&["sessionID", "part", "time"], &[]),
        _ => {
            return Err(OpenCodeImportError::Blocked(
                "durable V1 event has no supported pinned payload schema".into(),
            ));
        }
    };
    let Some(object) = data.as_object() else {
        return Err(OpenCodeImportError::Blocked(
            "durable V1 event payload is not an object".into(),
        ));
    };
    if required_keys.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| {
            !required_keys.contains(&key.as_str()) && !optional_keys.contains(&key.as_str())
        })
        || data
            .get("sessionID")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|value| !valid_session_id(value))
    {
        return Err(OpenCodeImportError::Blocked(
            "durable V1 event payload does not match its pinned top-level shape".into(),
        ));
    }
    match event_type {
        "session.created" | "session.updated" | "session.deleted" => {
            if !data
                .get("info")
                .is_some_and(|info| is_v1_session_info(info, data.get("sessionID").unwrap()))
            {
                return Err(OpenCodeImportError::Blocked(
                    "durable V1 session event info does not match the pinned SessionInfo schema"
                        .into(),
                ));
            }
        }
        "message.updated" => {
            if !data
                .get("info")
                .is_some_and(|info| is_v1_message_info(info, data.get("sessionID").unwrap()))
            {
                return Err(OpenCodeImportError::Blocked(
                    "durable V1 message event info does not match the pinned Message schema".into(),
                ));
            }
        }
        "message.part.updated" => {
            if !data
                .get("part")
                .is_some_and(|part| is_v1_part(part, data.get("sessionID").unwrap()))
                || !field_is(data, "time", is_finite_number)
            {
                return Err(OpenCodeImportError::Blocked(
                    "durable V1 part event does not match the pinned Part schema".into(),
                ));
            }
        }
        "message.removed" => {
            if !field_is(data, "messageID", |id| {
                id.as_str().is_some_and(valid_message_id)
            }) {
                return Err(OpenCodeImportError::Blocked(
                    "durable V1 message removal does not match the pinned schema".into(),
                ));
            }
        }
        "message.part.removed" => {
            if !field_is(data, "messageID", |id| {
                id.as_str().is_some_and(valid_message_id)
            }) || !field_is(data, "partID", |id| id.as_str().is_some_and(valid_part_id))
            {
                return Err(OpenCodeImportError::Blocked(
                    "durable V1 part removal does not match the pinned schema".into(),
                ));
            }
        }
        _ => unreachable!("unsupported V1 event rejected above"),
    }
    Ok(())
}

fn is_v1_file_diff(value: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &["additions", "deletions"],
        &["file", "patch", "status"],
    ) && field_is(value, "additions", is_finite_number)
        && field_is(value, "deletions", is_finite_number)
        && optional_field_is(value, "file", is_string)
        && optional_field_is(value, "patch", is_string)
        && optional_field_is(value, "status", |value| {
            matches!(value.as_str(), Some("added" | "deleted" | "modified"))
        })
}

fn is_v1_session_info(value: &serde_json::Value, session_id: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &[
            "id",
            "slug",
            "projectID",
            "directory",
            "title",
            "version",
            "time",
        ],
        &[
            "workspaceID",
            "path",
            "parentID",
            "summary",
            "cost",
            "tokens",
            "share",
            "agent",
            "model",
            "metadata",
            "permission",
            "revert",
        ],
    ) && value.get("id") == Some(session_id)
        && field_is(value, "id", |value| {
            value.as_str().is_some_and(valid_session_id)
        })
        && ["slug", "projectID", "directory", "title", "version"]
            .iter()
            .all(|key| field_is(value, key, is_string))
        && optional_field_is(value, "workspaceID", is_workspace_id)
        && optional_field_is(value, "path", is_string)
        && optional_field_is(value, "parentID", |value| {
            value.as_str().is_some_and(valid_session_id)
        })
        && optional_field_is(value, "summary", is_v1_session_summary)
        && optional_field_is(value, "cost", is_finite_number)
        && optional_field_is(value, "tokens", is_v1_session_tokens)
        && optional_field_is(value, "share", |share| {
            has_object_shape(share, &["url"], &[]) && field_is(share, "url", is_string)
        })
        && optional_field_is(value, "agent", is_string)
        && optional_field_is(value, "model", |model| {
            has_object_shape(model, &["id", "providerID"], &["variant"])
                && field_is(model, "id", is_string)
                && field_is(model, "providerID", is_string)
                && optional_field_is(model, "variant", is_string)
        })
        && optional_field_is(value, "metadata", is_unknown_record)
        && optional_field_is(value, "permission", |rules| {
            rules.as_array().is_some_and(|rules| {
                rules.iter().all(|rule| {
                    has_object_shape(rule, &["permission", "pattern", "action"], &[])
                        && field_is(rule, "permission", is_string)
                        && field_is(rule, "pattern", is_string)
                        && field_is(rule, "action", |action| {
                            matches!(action.as_str(), Some("allow" | "deny" | "ask"))
                        })
                })
            })
        })
        && optional_field_is(value, "revert", |revert| {
            has_object_shape(revert, &["messageID"], &["partID", "snapshot", "diff"])
                && field_is(revert, "messageID", |value| {
                    value.as_str().is_some_and(valid_message_id)
                })
                && optional_field_is(revert, "partID", |value| {
                    value.as_str().is_some_and(valid_part_id)
                })
                && optional_field_is(revert, "snapshot", is_string)
                && optional_field_is(revert, "diff", is_string)
        })
        && field_is(value, "time", |time| {
            has_object_shape(time, &["created", "updated"], &["compacting", "archived"])
                && field_is(time, "created", is_nonnegative_integer)
                && field_is(time, "updated", is_nonnegative_integer)
                && optional_field_is(time, "compacting", is_nonnegative_integer)
                && optional_field_is(time, "archived", is_finite_number)
        })
}

fn is_v1_session_summary(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["additions", "deletions", "files"], &["diffs"])
        && ["additions", "deletions", "files"]
            .iter()
            .all(|key| field_is(value, key, is_finite_number))
        && optional_field_is(value, "diffs", |diffs| {
            diffs
                .as_array()
                .is_some_and(|diffs| diffs.iter().all(is_v1_file_diff))
        })
}

fn is_v1_session_tokens(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["input", "output", "reasoning", "cache"], &[])
        && ["input", "output", "reasoning"]
            .iter()
            .all(|key| field_is(value, key, is_finite_number))
        && field_is(value, "cache", |cache| {
            has_object_shape(cache, &["read", "write"], &[])
                && field_is(cache, "read", is_finite_number)
                && field_is(cache, "write", is_finite_number)
        })
}

fn is_v1_message_info(value: &serde_json::Value, session_id: &serde_json::Value) -> bool {
    if value.get("sessionID") != Some(session_id)
        || !field_is(value, "id", |value| {
            value.as_str().is_some_and(valid_message_id)
        })
    {
        return false;
    }
    match value.get("role").and_then(serde_json::Value::as_str) {
        Some("user") => {
            has_object_shape(
                value,
                &["id", "sessionID", "role", "time", "agent", "model"],
                &["format", "summary", "system", "tools"],
            ) && field_is(value, "time", |time| {
                has_object_shape(time, &["created"], &[])
                    && field_is(time, "created", is_nonnegative_finite_number)
            }) && field_is(value, "agent", is_string)
                && field_is(value, "model", |model| {
                    has_object_shape(model, &["providerID", "modelID"], &["variant"])
                        && field_is(model, "providerID", is_string)
                        && field_is(model, "modelID", is_string)
                        && optional_field_is(model, "variant", is_string)
                })
                && optional_field_is(value, "format", is_v1_output_format)
                && optional_field_is(value, "summary", is_v1_message_summary)
                && optional_field_is(value, "system", is_string)
                && optional_field_is(value, "tools", |tools| {
                    tools
                        .as_object()
                        .is_some_and(|tools| tools.values().all(|value| value.as_bool().is_some()))
                })
        }
        Some("assistant") => {
            has_object_shape(
                value,
                &[
                    "id",
                    "sessionID",
                    "role",
                    "time",
                    "parentID",
                    "modelID",
                    "providerID",
                    "mode",
                    "agent",
                    "path",
                    "cost",
                    "tokens",
                ],
                &["error", "summary", "structured", "variant", "finish"],
            ) && field_is(value, "time", |time| {
                has_object_shape(time, &["created"], &["completed"])
                    && field_is(time, "created", is_nonnegative_integer)
                    && optional_field_is(time, "completed", is_nonnegative_integer)
            }) && field_is(value, "parentID", |value| {
                value.as_str().is_some_and(valid_message_id)
            }) && ["modelID", "providerID", "mode", "agent"]
                .iter()
                .all(|key| field_is(value, key, is_string))
                && field_is(value, "path", |path| {
                    has_object_shape(path, &["cwd", "root"], &[])
                        && field_is(path, "cwd", is_string)
                        && field_is(path, "root", is_string)
                })
                && field_is(value, "cost", is_finite_number)
                && field_is(value, "tokens", is_v1_message_tokens)
                && optional_field_is(value, "error", is_v1_assistant_error)
                && optional_field_is(value, "summary", |value| value.as_bool().is_some())
                && optional_field_is(value, "structured", |_| true)
                && optional_field_is(value, "variant", is_string)
                && optional_field_is(value, "finish", is_string)
        }
        _ => false,
    }
}

fn is_v1_output_format(value: &serde_json::Value) -> bool {
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("text") => has_object_shape(value, &["type"], &[]),
        Some("json_schema") => {
            has_object_shape(value, &["type", "schema"], &["retryCount"])
                && field_is(value, "schema", is_unknown_record)
                && optional_field_is(value, "retryCount", is_nonnegative_integer)
        }
        _ => false,
    }
}

fn is_v1_message_summary(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["diffs"], &["title", "body"])
        && optional_field_is(value, "title", is_string)
        && optional_field_is(value, "body", is_string)
        && field_is(value, "diffs", |diffs| {
            diffs
                .as_array()
                .is_some_and(|diffs| diffs.iter().all(is_v1_file_diff))
        })
}

fn is_v1_message_tokens(value: &serde_json::Value) -> bool {
    has_object_shape(
        value,
        &["input", "output", "reasoning", "cache"],
        &["total"],
    ) && optional_field_is(value, "total", is_finite_number)
        && ["input", "output", "reasoning"]
            .iter()
            .all(|key| field_is(value, key, is_finite_number))
        && field_is(value, "cache", |cache| {
            has_object_shape(cache, &["read", "write"], &[])
                && field_is(cache, "read", is_finite_number)
                && field_is(cache, "write", is_finite_number)
        })
}

fn is_v1_assistant_error(value: &serde_json::Value) -> bool {
    let (Some(name), Some(data)) = (
        value.get("name").and_then(serde_json::Value::as_str),
        value.get("data"),
    ) else {
        return false;
    };
    match name {
        "ProviderAuthError" => {
            has_object_shape(data, &["providerID", "message"], &[])
                && field_is(data, "providerID", is_string)
                && field_is(data, "message", is_string)
        }
        "UnknownError" => {
            has_object_shape(data, &["message"], &["ref"])
                && field_is(data, "message", is_string)
                && optional_field_is(data, "ref", is_string)
        }
        "MessageOutputLengthError" => has_object_shape(data, &[], &[]),
        "MessageAbortedError" | "ContextOverflowError" | "ContentFilterError" => {
            has_object_shape(
                data,
                &["message"],
                if name == "ContextOverflowError" {
                    &["responseBody"]
                } else {
                    &[]
                },
            ) && field_is(data, "message", is_string)
                && optional_field_is(data, "responseBody", is_string)
        }
        "StructuredOutputError" => {
            has_object_shape(data, &["message", "retries"], &[])
                && field_is(data, "message", is_string)
                && field_is(data, "retries", is_nonnegative_integer)
        }
        "APIError" => is_v1_api_error(value),
        _ => false,
    }
}

fn is_v1_api_error(value: &serde_json::Value) -> bool {
    value.get("name").and_then(serde_json::Value::as_str) == Some("APIError")
        && field_is(value, "data", |data| {
            has_object_shape(
                data,
                &["message", "isRetryable"],
                &["statusCode", "responseHeaders", "responseBody", "metadata"],
            ) && field_is(data, "message", is_string)
                && field_is(data, "isRetryable", |value| value.as_bool().is_some())
                && optional_field_is(data, "statusCode", is_nonnegative_integer)
                && optional_field_is(data, "responseHeaders", is_string_record)
                && optional_field_is(data, "responseBody", is_string)
                && optional_field_is(data, "metadata", is_string_record)
        })
}

fn is_v1_part(value: &serde_json::Value, session_id: &serde_json::Value) -> bool {
    if !field_is(value, "id", |value| {
        value.as_str().is_some_and(valid_part_id)
    }) || value.get("sessionID") != Some(session_id)
        || !field_is(value, "messageID", |value| {
            value.as_str().is_some_and(valid_message_id)
        })
    {
        return false;
    }
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("text") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "text"],
                &["synthetic", "ignored", "time", "metadata"],
            ) && field_is(value, "text", is_string)
                && optional_field_is(value, "synthetic", |value| value.as_bool().is_some())
                && optional_field_is(value, "ignored", |value| value.as_bool().is_some())
                && optional_field_is(value, "time", |time| {
                    has_object_shape(time, &["start"], &["end"])
                        && field_is(time, "start", is_nonnegative_integer)
                        && optional_field_is(time, "end", is_nonnegative_integer)
                })
                && optional_field_is(value, "metadata", is_unknown_record)
        }
        Some("reasoning") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "text", "time"],
                &["metadata"],
            ) && field_is(value, "text", is_string)
                && field_is(value, "time", |time| {
                    has_object_shape(time, &["start"], &["end"])
                        && field_is(time, "start", is_nonnegative_integer)
                        && optional_field_is(time, "end", is_nonnegative_integer)
                })
                && optional_field_is(value, "metadata", is_unknown_record)
        }
        Some("snapshot") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "snapshot"],
                &[],
            ) && field_is(value, "snapshot", is_string)
        }
        Some("patch") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "hash", "files"],
                &[],
            ) && field_is(value, "hash", is_string)
                && field_is(value, "files", is_string_array)
        }
        Some("file") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "mime", "url"],
                &["filename", "source"],
            ) && field_is(value, "mime", is_string)
                && field_is(value, "url", is_string)
                && optional_field_is(value, "filename", is_string)
                && optional_field_is(value, "source", is_v1_file_source)
        }
        Some("agent") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "name"],
                &["source"],
            ) && field_is(value, "name", is_string)
                && optional_field_is(value, "source", is_v1_text_source)
        }
        Some("compaction") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type", "auto"],
                &["overflow", "tail_start_id"],
            ) && field_is(value, "auto", |value| value.as_bool().is_some())
                && optional_field_is(value, "overflow", |value| value.as_bool().is_some())
                && optional_field_is(value, "tail_start_id", |value| {
                    value.as_str().is_some_and(valid_message_id)
                })
        }
        Some("subtask") => {
            has_object_shape(
                value,
                &[
                    "id",
                    "sessionID",
                    "messageID",
                    "type",
                    "prompt",
                    "description",
                    "agent",
                ],
                &["model", "command"],
            ) && ["prompt", "description", "agent"]
                .iter()
                .all(|key| field_is(value, key, is_string))
                && optional_field_is(value, "command", is_string)
                && optional_field_is(value, "model", |model| {
                    has_object_shape(model, &["providerID", "modelID"], &[])
                        && field_is(model, "providerID", is_string)
                        && field_is(model, "modelID", is_string)
                })
        }
        Some("step-start") => {
            has_object_shape(
                value,
                &["id", "sessionID", "messageID", "type"],
                &["snapshot"],
            ) && optional_field_is(value, "snapshot", is_string)
        }
        Some("step-finish") => {
            has_object_shape(
                value,
                &[
                    "id",
                    "sessionID",
                    "messageID",
                    "type",
                    "reason",
                    "cost",
                    "tokens",
                ],
                &["snapshot"],
            ) && field_is(value, "reason", is_string)
                && field_is(value, "cost", is_finite_number)
                && optional_field_is(value, "snapshot", is_string)
                && field_is(value, "tokens", |tokens| {
                    has_object_shape(
                        tokens,
                        &["input", "output", "reasoning", "cache"],
                        &["total"],
                    ) && optional_field_is(tokens, "total", is_finite_number)
                        && ["input", "output", "reasoning"]
                            .iter()
                            .all(|key| field_is(tokens, key, is_finite_number))
                        && field_is(tokens, "cache", |cache| {
                            has_object_shape(cache, &["read", "write"], &[])
                                && field_is(cache, "read", is_finite_number)
                                && field_is(cache, "write", is_finite_number)
                        })
                })
        }
        Some("retry") => {
            has_object_shape(
                value,
                &[
                    "id",
                    "sessionID",
                    "messageID",
                    "type",
                    "attempt",
                    "error",
                    "time",
                ],
                &[],
            ) && field_is(value, "attempt", is_nonnegative_integer)
                && field_is(value, "error", is_v1_api_error)
                && field_is(value, "time", |time| {
                    has_object_shape(time, &["created"], &[])
                        && field_is(time, "created", is_nonnegative_integer)
                })
        }
        Some("tool") => {
            has_object_shape(
                value,
                &[
                    "id",
                    "sessionID",
                    "messageID",
                    "type",
                    "callID",
                    "tool",
                    "state",
                ],
                &["metadata"],
            ) && field_is(value, "callID", is_string)
                && field_is(value, "tool", is_string)
                && optional_field_is(value, "metadata", is_unknown_record)
                && field_is(value, "state", is_v1_tool_state)
        }
        _ => false,
    }
}

fn is_v1_text_source(value: &serde_json::Value) -> bool {
    has_object_shape(value, &["value", "start", "end"], &[])
        && field_is(value, "value", is_string)
        && field_is(value, "start", is_nonnegative_integer)
        && field_is(value, "end", is_nonnegative_integer)
}

fn is_v1_file_source(value: &serde_json::Value) -> bool {
    let Some(kind) = value.get("type").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let valid_text = |text: &serde_json::Value| {
        has_object_shape(text, &["value", "start", "end"], &[])
            && field_is(text, "value", is_string)
            && field_is(text, "start", is_finite_number)
            && field_is(text, "end", is_finite_number)
    };
    match kind {
        "file" => {
            has_object_shape(value, &["type", "path", "text"], &[])
                && field_is(value, "path", is_string)
                && field_is(value, "text", valid_text)
        }
        "resource" => {
            has_object_shape(value, &["type", "clientName", "uri", "text"], &[])
                && field_is(value, "clientName", is_string)
                && field_is(value, "uri", is_string)
                && field_is(value, "text", valid_text)
        }
        "symbol" => {
            has_object_shape(
                value,
                &["type", "path", "text", "range", "name", "kind"],
                &[],
            ) && field_is(value, "path", is_string)
                && field_is(value, "name", is_string)
                && field_is(value, "kind", is_nonnegative_integer)
                && field_is(value, "text", valid_text)
                && field_is(value, "range", |range| {
                    has_object_shape(range, &["start", "end"], &[])
                        && ["start", "end"].iter().all(|key| {
                            field_is(range, key, |position| {
                                has_object_shape(position, &["line", "character"], &[])
                                    && field_is(position, "line", is_nonnegative_integer)
                                    && field_is(position, "character", is_nonnegative_integer)
                            })
                        })
                })
        }
        _ => false,
    }
}

fn is_v1_file_part(value: &serde_json::Value) -> bool {
    value.get("type").and_then(serde_json::Value::as_str) == Some("file")
        && value
            .get("sessionID")
            .and_then(serde_json::Value::as_str)
            .is_some_and(valid_session_id)
        && is_v1_part(
            value,
            value.get("sessionID").unwrap_or(&serde_json::Value::Null),
        )
}

fn is_v1_tool_state(value: &serde_json::Value) -> bool {
    match value.get("status").and_then(serde_json::Value::as_str) {
        Some("pending") => {
            has_object_shape(value, &["status", "input", "raw"], &[])
                && field_is(value, "input", is_unknown_record)
                && field_is(value, "raw", is_string)
        }
        Some("running") => {
            has_object_shape(value, &["status", "input", "time"], &["title", "metadata"])
                && field_is(value, "input", is_unknown_record)
                && field_is(value, "time", |time| {
                    has_object_shape(time, &["start"], &[])
                        && field_is(time, "start", is_nonnegative_integer)
                })
                && optional_field_is(value, "title", is_string)
                && optional_field_is(value, "metadata", is_unknown_record)
        }
        Some("completed") => {
            has_object_shape(
                value,
                &["status", "input", "output", "title", "metadata", "time"],
                &["attachments"],
            ) && field_is(value, "input", is_unknown_record)
                && field_is(value, "output", is_string)
                && field_is(value, "title", is_string)
                && field_is(value, "metadata", is_unknown_record)
                && field_is(value, "time", |time| {
                    has_object_shape(time, &["start", "end"], &["compacted"])
                        && field_is(time, "start", is_nonnegative_integer)
                        && field_is(time, "end", is_nonnegative_integer)
                        && optional_field_is(time, "compacted", is_nonnegative_integer)
                })
                && optional_field_is(value, "attachments", |attachments| {
                    attachments
                        .as_array()
                        .is_some_and(|attachments| attachments.iter().all(is_v1_file_part))
                })
        }
        Some("error") => {
            has_object_shape(value, &["status", "input", "error", "time"], &["metadata"])
                && field_is(value, "input", is_unknown_record)
                && field_is(value, "error", is_string)
                && field_is(value, "time", |time| {
                    has_object_shape(time, &["start", "end"], &[])
                        && field_is(time, "start", is_nonnegative_integer)
                        && field_is(time, "end", is_nonnegative_integer)
                })
                && optional_field_is(value, "metadata", is_unknown_record)
        }
        _ => false,
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

fn verify_current_references(
    manifest: &OpenCodeTransferManifest,
    current_rows: &BTreeMap<(String, Vec<SerializedSqlValue>), SerializedRow>,
    database_path: &Path,
    workspace_root: &Path,
) -> Result<(), OpenCodeImportError> {
    let rows = current_rows.values().cloned().collect::<Vec<_>>();
    freshell_sessions::opencode_transfer::verify_saved_snapshot_references(
        &manifest.saved_snapshots,
        &rows,
        database_path,
        workspace_root,
    )
    .map_err(|error| OpenCodeImportError::Blocked(error.to_string()))?;
    freshell_sessions::opencode_transfer::verify_asset_references(
        &manifest.assets,
        &rows,
        workspace_root,
    )
    .map_err(|_| {
        OpenCodeImportError::Blocked(
            "workspace or Git assets do not match the imported closure".into(),
        )
    })
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
    for asset in &manifest.assets {
        hasher.update(serde_json::to_vec(asset).map_err(|_| {
            OpenCodeImportError::Metadata("asset evidence cannot be encoded".into())
        })?);
        hasher.update([0]);
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
    if manifest.version != 1
        || manifest.provider_schema != DESTINATION_SCHEMA
        || manifest.root_session_id != descriptor.root_session_id
        || manifest.source_store_id != descriptor.source_store_id
        || manifest.generation != descriptor.source_generation
        || manifest.source_schema_fingerprint != descriptor.source_schema_fingerprint
        || manifest.migration_journal_fingerprint != descriptor.migration_journal_fingerprint
        || manifest.row_count != manifest.rows.len()
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
    if sha256(&encoded) != manifest.generation {
        return Err(OpenCodeImportError::Metadata(
            "manifest generation fingerprint is invalid".into(),
        ));
    }
    let mut rows = BTreeSet::new();
    for row in &manifest.rows {
        if row.table.is_empty()
            || row.sha256.len() != 64
            || !rows.insert((row.table.clone(), row.key.clone()))
        {
            return Err(OpenCodeImportError::Metadata(
                "manifest row fingerprints are invalid or duplicated".into(),
            ));
        }
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

fn verify_manifest_rows(
    connection: &Connection,
    manifest: &OpenCodeTransferManifest,
) -> Result<(), OpenCodeImportError> {
    for expected in &manifest.rows {
        let row = read_row_by_key(connection, &expected.table, &expected.key)?;
        if digest_serialized_row(&row)? != expected.sha256 {
            return Err(OpenCodeImportError::Blocked(
                "installed native row differs from the exported baseline".into(),
            ));
        }
    }
    Ok(())
}

fn verify_exact_installed_closure(
    connection: &Connection,
    manifest: &OpenCodeTransferManifest,
) -> Result<(), OpenCodeImportError> {
    let ids = read_descendant_session_ids(connection, &manifest.root_session_id)?;
    let actual = read_current_session_rows(connection, &ids)?;
    let expected_keys = manifest
        .rows
        .iter()
        .map(|row| (row.table.clone(), row.key.clone()))
        .collect::<BTreeSet<_>>();
    if actual.keys().cloned().collect::<BTreeSet<_>>() != expected_keys {
        return Err(OpenCodeImportError::Blocked(
            "installed store has an unreceipted extra native graph".into(),
        ));
    }
    freshell_sessions::opencode_transfer::verify_native_cleanup_baselines(
        &manifest.native_cleanup_baselines,
        &actual.into_values().collect::<Vec<_>>(),
    )
    .map_err(|_| {
        OpenCodeImportError::Blocked("native cleanup baseline ordering or boundary differs".into())
    })?;
    Ok(())
}

fn read_manifest_session_rows(
    connection: &Connection,
    manifest: &OpenCodeTransferManifest,
) -> Result<Vec<SerializedRow>, OpenCodeImportError> {
    manifest
        .rows
        .iter()
        .filter(|row| row.table == "session")
        .map(|row| read_row_by_key(connection, &row.table, &row.key))
        .collect()
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
        asset_count: manifest.assets.len() as u64,
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

#[cfg(test)]
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

struct PayloadSeed<'a, 'connection> {
    transaction: &'a Transaction<'connection>,
    manifest: &'a OpenCodeTransferManifest,
    row_index: &'a mut usize,
    destination_database: &'a Path,
}

impl<'de, 'a, 'connection> de::DeserializeSeed<'de> for PayloadSeed<'a, 'connection> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_map(PayloadVisitor(self))
    }
}

struct PayloadVisitor<'a, 'connection>(PayloadSeed<'a, 'connection>);

impl<'de, 'a, 'connection> de::Visitor<'de> for PayloadVisitor<'a, 'connection> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("an OpenCode transfer payload")
    }

    fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
    where
        M: de::MapAccess<'de>,
    {
        let mut version = None;
        let mut root = None;
        let mut rows_seen = false;
        let mut assets = None;
        let mut snapshot_objects_seen = false;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" if version.is_none() => version = Some(map.next_value::<u32>()?),
                "root_session_id" if root.is_none() => root = Some(map.next_value::<String>()?),
                "rows" if !rows_seen => {
                    rows_seen = true;
                    map.next_value_seed(RowsSeed {
                        transaction: self.0.transaction,
                        manifest: self.0.manifest,
                        row_index: self.0.row_index,
                    })?;
                }
                "assets" if assets.is_none() => {
                    assets = Some(map.next_value::<Vec<SerializedAssetMetadata>>()?);
                }
                "snapshot_objects" if !snapshot_objects_seen => {
                    snapshot_objects_seen = true;
                    map.next_value_seed(SnapshotObjectsSeed {
                        manifest: self.0.manifest,
                        destination_database: self.0.destination_database,
                    })?;
                }
                _ => {
                    let _: de::IgnoredAny = map.next_value()?;
                }
            }
        }
        if version != Some(1)
            || root.as_deref() != Some(self.0.manifest.root_session_id.as_str())
            || !rows_seen
            || assets.as_deref() != Some(self.0.manifest.assets.as_slice())
            || *self.0.row_index != self.0.manifest.rows.len()
            || (!snapshot_objects_seen
                && self
                    .0
                    .manifest
                    .saved_snapshots
                    .iter()
                    .any(|reference| !reference.objects.is_empty()))
        {
            return Err(de::Error::custom(
                "payload metadata disagrees with its manifest",
            ));
        }
        Ok(())
    }
}

struct SnapshotObjectsSeed<'a> {
    manifest: &'a OpenCodeTransferManifest,
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
        formatter.write_str("the exact retained snapshot object closure")
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
                &self.manifest.saved_snapshots,
                self.destination_database,
            )
            .map_err(de::Error::custom)?;
        }
        let expected = self
            .manifest
            .saved_snapshots
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
                "snapshot payload does not match the exact retained closure",
            ));
        }
        Ok(())
    }
}

struct RowsSeed<'a, 'connection> {
    transaction: &'a Transaction<'connection>,
    manifest: &'a OpenCodeTransferManifest,
    row_index: &'a mut usize,
}

impl<'de, 'a, 'connection> de::DeserializeSeed<'de> for RowsSeed<'a, 'connection> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: de::Deserializer<'de>,
    {
        deserializer.deserialize_seq(RowsVisitor(self))
    }
}

struct RowsVisitor<'a, 'connection>(RowsSeed<'a, 'connection>);

impl<'de, 'a, 'connection> de::Visitor<'de> for RowsVisitor<'a, 'connection> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the exported native row sequence")
    }

    fn visit_seq<S>(self, mut sequence: S) -> Result<Self::Value, S::Error>
    where
        S: de::SeqAccess<'de>,
    {
        while let Some(row) = sequence.next_element::<SerializedRow>()? {
            let index = *self.0.row_index;
            let expected = self
                .0
                .manifest
                .rows
                .get(index)
                .ok_or_else(|| de::Error::custom("payload has an unexpected native row"))?;
            if row.table != expected.table
                || row.key != expected.key
                || digest_serialized_row(&row).map_err(de::Error::custom)? != expected.sha256
            {
                return Err(de::Error::custom(
                    "native row digest disagrees with manifest",
                ));
            }
            insert_or_compare_row(self.0.transaction, &row).map_err(de::Error::custom)?;
            *self.0.row_index += 1;
        }
        if *self.0.row_index != self.0.manifest.rows.len() {
            return Err(de::Error::custom("payload is missing native rows"));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "opencode_transfer_tests.rs"]
mod tests;
