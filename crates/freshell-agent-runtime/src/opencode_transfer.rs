//! Transactional installation of an exact OpenCode history bundle.
//!
//! The importer accepts only the pinned Task 1 bundle shape. It creates the
//! pinned destination schema when needed, inserts rows without overwriting a
//! conflict, and independently re-reads the installed rows before returning a
//! body-free receipt.

use std::{
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
    OpenCodeTransferManifest, SerializedAssetMetadata, SerializedRow, SerializedSqlValue,
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

struct FilesystemCapacityProvider;

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
        }
        .deserialize(&mut deserializer)
        .map_err(|_| {
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
    let session_rows = read_manifest_session_rows(&transaction, &manifest)?;
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
    transaction.commit()?;
    drop(connection);
    sync_file_and_parent(destination_database)?;
    let structural_sha256 = structural_digest(&manifest);
    Ok(receipt_for(descriptor, &manifest, structural_sha256))
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
    validate_foreign_keys(&connection)?;
    let session_rows = read_manifest_session_rows(&connection, &manifest)?;
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
        {
            return Err(de::Error::custom(
                "payload metadata disagrees with its manifest",
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
