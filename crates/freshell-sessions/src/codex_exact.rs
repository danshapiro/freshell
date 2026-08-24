//! Strict, read-only Codex exact-recovery ownership proofs.
//!
//! This module follows Codex's native DB-first resolver shape while remaining
//! stricter at every uncertainty boundary: SQLite rows are only accelerators,
//! rollout metadata is ownership authority, and no incomplete read authorizes
//! a process.

use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::fs::Metadata;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use freshell_protocol::SessionLocator;
use freshell_recovery::{
    DurableRecoveryProvider, ExactRecoveryIssue, ExactRecoveryLookupKey, ExactRecoveryProof,
    ExactRecoveryProviderResult, ExactRecoveryProviderSnapshot, ExactRecoveryQuery,
    ExactRecoveryState, RecoveryOwnerKey,
};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{Map, Value};

const STATE_DATABASE: &str = "state_5.sqlite";
const ACTIVE_SUBDIR: &str = "sessions";
const ARCHIVED_SUBDIR: &str = "archived_sessions";
const CURRENT_STATE_MIGRATION: i64 = 42;
const MAX_EXACT_BATCH: usize = 256;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 50_000;
const MAX_SCAN_DIRECTORIES: usize = 8_192;
const MAX_RELEVANT_CANDIDATES: usize = 2_048;
const MAX_METADATA_RECORDS: usize = 64;
const MAX_METADATA_BYTES: u64 = 512 * 1024;
const MAX_COMPRESSED_METADATA_BYTES: u64 = 512 * 1024;
const ZSTD_MAX_WINDOW_LOG: u32 = 23;
const SQLITE_PROGRESS_INTERVAL: i32 = 1_000;
const SQLITE_PROGRESS_CALLBACK_LIMIT: usize = 10_000;
const SQLITE_QUERY_DEADLINE: Duration = Duration::from_millis(300);

/// The independently resolved roots used by one Codex exact batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexExactStore {
    /// Codex's rollout/config root (`CODEX_HOME` or its configured equivalent).
    pub codex_home: PathBuf,
    /// Codex's independent state database root.
    pub sqlite_home: PathBuf,
}

#[derive(Debug)]
enum DirectoryEvidence {
    Missing {
        requested: PathBuf,
    },
    Present {
        requested: PathBuf,
        canonical: PathBuf,
        identity: FileIdentity,
    },
}

impl DirectoryEvidence {
    fn resolve(requested: PathBuf) -> Result<Self, ExactRecoveryIssue> {
        let canonical = match std::fs::canonicalize(&requested) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::Missing { requested });
            }
            Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
        };
        let metadata =
            std::fs::metadata(&canonical).map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        if !metadata.is_dir() {
            return Err(ExactRecoveryIssue::StoreReadFailed);
        }
        let identity = stable_directory_identity(&canonical)
            .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        Ok(Self::Present {
            requested,
            canonical,
            identity,
        })
    }

    fn canonical(&self) -> Option<&Path> {
        match self {
            Self::Missing { .. } => None,
            Self::Present { canonical, .. } => Some(canonical),
        }
    }

    fn unchanged(&self) -> bool {
        match self {
            Self::Missing { requested } => std::fs::symlink_metadata(requested)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            Self::Present {
                requested,
                canonical,
                identity,
            } => {
                std::fs::canonicalize(requested).is_ok_and(|resolved| &resolved == canonical)
                    && stable_directory_identity(canonical)
                        .is_ok_and(|current| &current == identity)
            }
        }
    }

    fn fingerprint_component(&self) -> String {
        match self {
            Self::Missing { requested } => {
                format!("missing:{}", requested.to_string_lossy())
            }
            Self::Present {
                canonical,
                identity,
                ..
            } => format!(
                "present:{}:{}",
                canonical.to_string_lossy(),
                identity.fingerprint_component()
            ),
        }
    }
}

struct CodexBatchRoots {
    codex_home: DirectoryEvidence,
    sqlite_home: DirectoryEvidence,
    rollout_roots: [DirectoryEvidence; 2],
}

impl CodexBatchRoots {
    fn resolve(store: &CodexExactStore) -> Result<Self, ExactRecoveryIssue> {
        Ok(Self {
            codex_home: DirectoryEvidence::resolve(store.codex_home.clone())?,
            sqlite_home: DirectoryEvidence::resolve(store.sqlite_home.clone())?,
            rollout_roots: [
                DirectoryEvidence::resolve(store.codex_home.join(ACTIVE_SUBDIR))?,
                DirectoryEvidence::resolve(store.codex_home.join(ARCHIVED_SUBDIR))?,
            ],
        })
    }

    fn unchanged(&self) -> bool {
        self.codex_home.unchanged()
            && self.sqlite_home.unchanged()
            && self.rollout_roots.iter().all(DirectoryEvidence::unchanged)
    }

    fn canonical_rollout_roots(&self) -> impl Iterator<Item = &Path> {
        self.rollout_roots
            .iter()
            .filter_map(DirectoryEvidence::canonical)
    }
}

/// Resolve the SQLite root with Codex 0.145 precedence:
/// config.toml `sqlite_home`, then `CODEX_SQLITE_HOME`, then `CODEX_HOME`.
///
/// TOML-relative values are relative to `codex_home`; environment-relative
/// values are relative to the process cwd supplied by the composition root.
/// The config file is read safely and with a fixed byte cap.
pub fn resolve_codex_exact_store(
    codex_home: &Path,
    codex_sqlite_home: Option<&Path>,
    process_cwd: &Path,
) -> std::io::Result<CodexExactStore> {
    let configured = read_configured_sqlite_home(codex_home)?;
    let sqlite_home = if let Some(configured) = configured {
        resolve_relative(configured, codex_home)
    } else if let Some(environment) = codex_sqlite_home.filter(|path| !path.as_os_str().is_empty())
    {
        resolve_relative(environment.to_path_buf(), process_cwd)
    } else {
        codex_home.to_path_buf()
    };
    Ok(CodexExactStore {
        codex_home: codex_home.to_path_buf(),
        sqlite_home,
    })
}

fn resolve_relative(path: PathBuf, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn read_configured_sqlite_home(codex_home: &Path) -> std::io::Result<Option<PathBuf>> {
    let path = codex_home.join("config.toml");
    let mut file = match open_regular_nonblocking_nofollow(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Codex config exceeds exact-recovery bound",
        ));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "Codex config is not UTF-8")
    })?;
    let config: toml::Value = toml::from_str(text).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Codex config is not valid TOML",
        )
    })?;
    match config.get("sqlite_home") {
        None => Ok(None),
        Some(toml::Value::String(path)) if !path.is_empty() => Ok(Some(PathBuf::from(path))),
        Some(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Codex sqlite_home is not a non-empty path string",
        )),
    }
}

/// Resolve a complete request batch using one read-only DB connection and, if
/// needed, one bounded active/archive tree walk.
pub fn lookup_codex_exact_many_in_store(
    store: &CodexExactStore,
    queries: &[ExactRecoveryQuery],
) -> ExactRecoveryProviderSnapshot {
    lookup_codex_exact_many_in_store_with_root_recheck_hook(store, queries, || {})
}

fn lookup_codex_exact_many_in_store_with_root_recheck_hook(
    store: &CodexExactStore,
    queries: &[ExactRecoveryQuery],
    before_root_recheck: impl FnOnce(),
) -> ExactRecoveryProviderSnapshot {
    let mut output = ExactRecoveryProviderSnapshot::new();
    let mut valid_by_id = HashMap::<
        String,
        Vec<(
            ExactRecoveryLookupKey,
            freshell_recovery::MaterializationState,
        )>,
    >::new();
    let mut valid_key_count = 0usize;

    for query in queries {
        let validation = if query.mode != DurableRecoveryProvider::Codex {
            let issue = freshell_recovery::validate_session_ref(
                query.mode.as_str(),
                &query.key.session_ref,
            )
            .err()
            .unwrap_or(ExactRecoveryIssue::ProviderModeMismatch);
            Err(issue)
        } else {
            freshell_recovery::validate_session_ref("codex", &query.key.session_ref)
        };
        let session_ref = match validation {
            Ok(session_ref) => session_ref,
            Err(issue) => {
                output.insert(
                    query.key.clone(),
                    ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Invalid(issue)),
                );
                continue;
            }
        };
        let key = ExactRecoveryLookupKey {
            session_ref,
            cwd: query.key.cwd.clone(),
        };
        let entries = valid_by_id
            .entry(key.session_ref.session_id.clone())
            .or_default();
        if let Some((_, materialization)) = entries.iter_mut().find(|(prior, _)| prior == &key) {
            *materialization = materialization.advance(query.materialization);
        } else {
            entries.push((key, query.materialization));
            valid_key_count += 1;
        }
    }

    if valid_key_count > MAX_EXACT_BATCH {
        for entries in valid_by_id.into_values() {
            for (key, _) in entries {
                output.insert(
                    key,
                    ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                        ExactRecoveryIssue::ArtifactIncomplete,
                    )),
                );
            }
        }
        return output;
    }
    if valid_by_id.is_empty() {
        return output;
    }

    let roots = match CodexBatchRoots::resolve(store) {
        Ok(roots) => roots,
        Err(issue) => {
            for entries in valid_by_id.into_values() {
                for (key, _) in entries {
                    output.insert(
                        key,
                        ExactRecoveryProviderResult::unscoped(ExactRecoveryState::Retryable(
                            issue.clone(),
                        )),
                    );
                }
            }
            return output;
        }
    };
    let ids: Vec<String> = valid_by_id.keys().cloned().collect();
    let mut states = lookup_valid_codex_ids(store, &roots, &ids);
    before_root_recheck();
    if !roots.unchanged() {
        states = ids
            .iter()
            .cloned()
            .map(|id| {
                (
                    id,
                    ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactChanged),
                )
            })
            .collect();
    }
    for (session_id, entries) in valid_by_id {
        let state = states
            .get(&session_id)
            .cloned()
            .unwrap_or(ExactRecoveryState::Retryable(ExactRecoveryIssue::Unproved));
        log_codex_state(&session_id, &state);
        for (key, _) in entries {
            output.insert(key, ExactRecoveryProviderResult::unscoped(state.clone()));
        }
    }
    output
}

fn log_codex_state(session_id: &str, state: &ExactRecoveryState) {
    match state {
        ExactRecoveryState::Retryable(issue)
            if !matches!(
                issue,
                ExactRecoveryIssue::ArtifactMissing | ExactRecoveryIssue::Unproved
            ) =>
        {
            tracing::warn!(
                provider = "codex",
                session_id,
                issue = issue.code(),
                "exact_recovery_provider_lookup_retryable"
            );
        }
        ExactRecoveryState::Conflict => {
            tracing::warn!(
                provider = "codex",
                session_id,
                issue = "ambiguous_artifact",
                "exact_recovery_provider_lookup_conflict"
            );
        }
        _ => {}
    }
}

#[derive(Debug)]
enum DatabaseBatch {
    Missing,
    Rows(HashMap<String, String>),
    Failed(ExactRecoveryIssue),
}

struct CheckedRegularFile {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

impl CheckedRegularFile {
    fn open(path: PathBuf) -> Result<Option<Self>, ExactRecoveryIssue> {
        let file = match open_regular_nonblocking_nofollow(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
        };
        let metadata = file
            .metadata()
            .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        if !metadata.is_file() {
            return Err(ExactRecoveryIssue::StoreReadFailed);
        }
        let identity =
            FileIdentity::from_file(&file).map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
        Ok(Some(Self {
            path,
            file,
            identity,
        }))
    }

    fn unchanged(&self) -> bool {
        FileIdentity::from_file(&self.file).is_ok_and(|current| current == self.identity)
            && stable_regular_path_identity(&self.path)
                .is_ok_and(|current| current == self.identity)
    }
}

fn lookup_valid_codex_ids(
    store: &CodexExactStore,
    roots: &CodexBatchRoots,
    session_ids: &[String],
) -> HashMap<String, ExactRecoveryState> {
    let mut resolved = HashMap::new();
    let mut unresolved: HashSet<String> = session_ids.iter().cloned().collect();
    match read_database_rows(store, session_ids) {
        DatabaseBatch::Failed(issue) => {
            return session_ids
                .iter()
                .cloned()
                .map(|id| (id, ExactRecoveryState::Retryable(issue.clone())))
                .collect();
        }
        DatabaseBatch::Missing => {}
        DatabaseBatch::Rows(rows) => {
            for session_id in session_ids {
                let Some(untrusted_path) = rows.get(session_id) else {
                    continue;
                };
                match verify_database_rollout(store, roots, untrusted_path, session_id) {
                    DbCandidate::Verified(artifact) => {
                        unresolved.remove(session_id);
                        resolved.insert(
                            session_id.clone(),
                            present_codex_state(roots, session_id, &artifact),
                        );
                    }
                    DbCandidate::NeedsFallback => {}
                    DbCandidate::Failed(issue) => {
                        unresolved.remove(session_id);
                        resolved.insert(session_id.clone(), ExactRecoveryState::Retryable(issue));
                    }
                }
            }
        }
    }

    if !unresolved.is_empty() {
        resolved.extend(scan_fallbacks(roots, &unresolved));
    }
    resolved
}

fn read_database_rows(store: &CodexExactStore, session_ids: &[String]) -> DatabaseBatch {
    let path = store.sqlite_home.join(STATE_DATABASE);
    let checked = match CheckedRegularFile::open(path.clone()) {
        Ok(Some(checked)) => checked,
        Ok(None) => return DatabaseBatch::Missing,
        Err(issue) => return DatabaseBatch::Failed(issue),
    };
    let mut sidecars = Vec::new();
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match CheckedRegularFile::open(PathBuf::from(sidecar)) {
            Ok(Some(checked)) => sidecars.push(checked),
            Ok(None) => {}
            Err(issue) => return DatabaseBatch::Failed(issue),
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let connection = match Connection::open_with_flags(&path, flags) {
        Ok(connection) => connection,
        Err(_) => return DatabaseBatch::Failed(ExactRecoveryIssue::StoreReadFailed),
    };
    let deadline = Instant::now() + SQLITE_QUERY_DEADLINE;
    let mut callbacks_remaining = SQLITE_PROGRESS_CALLBACK_LIMIT;
    connection.progress_handler(
        SQLITE_PROGRESS_INTERVAL,
        Some(move || {
            if callbacks_remaining == 0 || Instant::now() >= deadline {
                true
            } else {
                callbacks_remaining -= 1;
                false
            }
        }),
    );
    if connection.busy_timeout(Duration::ZERO).is_err()
        || connection.execute_batch("BEGIN DEFERRED").is_err()
    {
        return DatabaseBatch::Failed(ExactRecoveryIssue::StoreReadFailed);
    }
    let rows = (|| -> rusqlite::Result<HashMap<String, String>> {
        validate_state_schema(&connection)?;
        let placeholders = (1..=session_ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("SELECT id, rollout_path FROM threads WHERE id IN ({placeholders})");
        let mut statement = connection.prepare(&sql)?;
        let iter = statement.query_map(params_from_iter(session_ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut found = HashMap::new();
        for row in iter {
            let (id, path) = row?;
            found.insert(id, path);
        }
        Ok(found)
    })();
    let _ = connection.execute_batch("ROLLBACK");
    drop(connection);

    if !checked.unchanged() || sidecars.iter().any(|sidecar| !sidecar.unchanged()) {
        return DatabaseBatch::Failed(ExactRecoveryIssue::ArtifactChanged);
    }
    match rows {
        Ok(rows) => DatabaseBatch::Rows(rows),
        Err(_) => DatabaseBatch::Failed(ExactRecoveryIssue::StoreReadFailed),
    }
}

fn validate_state_schema(connection: &Connection) -> rusqlite::Result<()> {
    let (latest, all_successful): (Option<i64>, Option<i64>) = connection.query_row(
        "SELECT MAX(version), MIN(success) FROM _sqlx_migrations",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !matches!(latest, Some(1..=CURRENT_STATE_MIGRATION)) || all_successful != Some(1) {
        return Err(rusqlite::Error::InvalidQuery);
    }

    let mut statement = connection.prepare("PRAGMA table_info(threads)")?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let valid_id = columns.iter().any(|(name, kind, _, primary)| {
        name == "id" && kind.eq_ignore_ascii_case("TEXT") && *primary == 1
    });
    let sole_primary_key = columns
        .iter()
        .filter(|(_, _, _, primary)| *primary > 0)
        .count()
        == 1;
    let valid_rollout = columns.iter().any(|(name, kind, not_null, _)| {
        name == "rollout_path" && kind.eq_ignore_ascii_case("TEXT") && *not_null == 1
    });
    if valid_id && sole_primary_key && valid_rollout {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidQuery)
    }
}

enum DbCandidate {
    Verified(CodexArtifact),
    NeedsFallback,
    Failed(ExactRecoveryIssue),
}

fn verify_database_rollout(
    store: &CodexExactStore,
    roots: &CodexBatchRoots,
    untrusted_path: &str,
    session_id: &str,
) -> DbCandidate {
    let supplied = PathBuf::from(untrusted_path);
    let supplied = if supplied.is_absolute() {
        supplied
    } else {
        store.codex_home.join(supplied)
    };
    let canonical = match preferred_rollout_representation(&supplied) {
        Ok(Some(path)) => path,
        Ok(None) => return DbCandidate::NeedsFallback,
        Err(issue) => return DbCandidate::Failed(issue),
    };
    if !roots
        .canonical_rollout_roots()
        .any(|root| canonical.starts_with(root))
    {
        return DbCandidate::Failed(ExactRecoveryIssue::StoreReadFailed);
    }
    match inspect_codex_rollout(&canonical, session_id) {
        Ok(Inspection::Owned(artifact)) => DbCandidate::Verified(artifact),
        Ok(Inspection::Unowned) => DbCandidate::NeedsFallback,
        Err(issue) => DbCandidate::Failed(issue),
    }
}

/// Codex treats `.jsonl` and `.jsonl.zst` as representations of one logical
/// rollout and always selects a co-located plain file when it exists.
fn preferred_rollout_representation(
    supplied: &Path,
) -> Result<Option<PathBuf>, ExactRecoveryIssue> {
    let file_name = supplied
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(ExactRecoveryIssue::StoreReadFailed)?;
    let plain_name = file_name.strip_suffix(".zst").unwrap_or(file_name);
    let plain = supplied.with_file_name(plain_name);
    match std::fs::canonicalize(&plain) {
        Ok(path) => return Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(ExactRecoveryIssue::StoreReadFailed),
    }
    let mut compressed_name = plain.as_os_str().to_os_string();
    compressed_name.push(".zst");
    match std::fs::canonicalize(PathBuf::from(compressed_name)) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ExactRecoveryIssue::StoreReadFailed),
    }
}

fn scan_fallbacks(
    roots: &CodexBatchRoots,
    unresolved: &HashSet<String>,
) -> HashMap<String, ExactRecoveryState> {
    let mut candidates = HashMap::<String, Vec<PathBuf>>::new();
    let mut per_id_issue = HashMap::<String, ExactRecoveryIssue>::new();
    let mut global_issue = None;
    let mut entries_seen = 0usize;
    let mut directories_seen = 0usize;
    let mut stack = Vec::new();
    let mut seen_roots = HashSet::new();
    for root in roots.canonical_rollout_roots() {
        if seen_roots.insert(root.to_path_buf()) {
            stack.push(root.to_path_buf());
        }
    }

    while let Some(directory) = stack.pop() {
        directories_seen += 1;
        if directories_seen > MAX_SCAN_DIRECTORIES {
            global_issue = Some(ExactRecoveryIssue::ArtifactIncomplete);
            break;
        }
        let read_dir = match std::fs::read_dir(&directory) {
            Ok(read_dir) => read_dir,
            Err(_) => {
                global_issue = Some(ExactRecoveryIssue::StoreReadFailed);
                continue;
            }
        };
        let mut entries = Vec::new();
        for entry in read_dir {
            entries_seen += 1;
            if entries_seen > MAX_SCAN_ENTRIES {
                global_issue = Some(ExactRecoveryIssue::ArtifactIncomplete);
                break;
            }
            match entry {
                Ok(entry) => entries.push(entry),
                Err(_) => global_issue = Some(ExactRecoveryIssue::StoreReadFailed),
            }
        }
        if entries_seen > MAX_SCAN_ENTRIES {
            break;
        }
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    global_issue = Some(ExactRecoveryIssue::StoreReadFailed);
                    continue;
                }
            };
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            let Some((logical_name, session_id)) = logical_rollout_name(&entry.path()) else {
                continue;
            };
            if !unresolved.contains(&session_id) {
                continue;
            }
            if !file_type.is_file() {
                per_id_issue.insert(session_id, ExactRecoveryIssue::StoreReadFailed);
                continue;
            }
            let list = candidates.entry(session_id).or_default();
            if list.len() >= MAX_RELEVANT_CANDIDATES {
                global_issue = Some(ExactRecoveryIssue::ArtifactIncomplete);
                continue;
            }
            // Codex treats the plain sibling as the logical artifact when both
            // plain and compressed forms coexist during compression rollover.
            if entry.path().extension().and_then(|value| value.to_str()) == Some("zst")
                && list.iter().any(|path| {
                    logical_rollout_name(path).is_some_and(|(prior, _)| prior == logical_name)
                        && path.parent() == entry.path().parent()
                        && path.extension().and_then(|value| value.to_str()) != Some("zst")
                })
            {
                continue;
            }
            if entry.path().extension().and_then(|value| value.to_str()) != Some("zst") {
                list.retain(|path| {
                    logical_rollout_name(path).is_none_or(|(prior, _)| {
                        prior != logical_name || path.parent() != entry.path().parent()
                    })
                });
            }
            list.push(entry.path());
        }
    }

    let mut results = HashMap::new();
    for session_id in unresolved {
        let mut owned = Vec::new();
        let mut identities = HashSet::new();
        let mut issue = per_id_issue.remove(session_id);
        let mut paths = candidates.remove(session_id).unwrap_or_default();
        paths.sort();
        for path in paths {
            match inspect_codex_rollout(&path, session_id) {
                Ok(Inspection::Owned(artifact)) => {
                    if identities.insert(artifact.identity.clone()) {
                        owned.push(artifact);
                    }
                }
                Ok(Inspection::Unowned) => {}
                Err(found) => {
                    issue.get_or_insert(found);
                }
            }
        }
        let state = if owned.len() > 1 {
            ExactRecoveryState::Conflict
        } else if let Some(found) = global_issue.clone().or(issue) {
            ExactRecoveryState::Retryable(found)
        } else if let Some(artifact) = owned.pop() {
            present_codex_state(roots, session_id, &artifact)
        } else {
            ExactRecoveryState::Retryable(ExactRecoveryIssue::ArtifactMissing)
        };
        results.insert(session_id.clone(), state);
    }
    results
}

/// Parse a native fallback filename:
/// `rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl[.zst]`.
///
/// State-DB paths deliberately do not use this parser: native Codex treats
/// their metadata as authority and permits custom filenames.
fn logical_rollout_name(path: &Path) -> Option<(String, String)> {
    let file_name = path.file_name()?.to_str()?;
    let plain = file_name.strip_suffix(".zst").unwrap_or(file_name);
    let stem = plain.strip_suffix(".jsonl")?;
    let session_id_start = stem.len().checked_sub(36)?;
    if session_id_start == 0 || stem.as_bytes().get(session_id_start - 1) != Some(&b'-') {
        return None;
    }
    let timestamp = stem
        .get("rollout-".len()..session_id_start - 1)
        .filter(|_| stem.starts_with("rollout-"))?;
    if timestamp.len() != 19
        || chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").is_err()
    {
        return None;
    }
    let session_id = stem.get(session_id_start..)?;
    let canonical = freshell_recovery::validate_session_ref(
        "codex",
        &SessionLocator {
            provider: "codex".to_string(),
            session_id: session_id.to_string(),
        },
    )
    .ok()?;
    Some((plain.to_string(), canonical.session_id))
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume_serial_number: u64,
    #[cfg(windows)]
    file_id: [u8; 16],
}

impl FileIdentity {
    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }

    fn from_file(file: &File) -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self::from_metadata(&file.metadata()?))
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
            };

            let mut information = FILE_ID_INFO::default();
            let result = unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle() as _,
                    FileIdInfo,
                    std::ptr::addr_of_mut!(information).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            };
            if result == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(Self {
                volume_serial_number: information.VolumeSerialNumber,
                file_id: information.FileId.Identifier,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = file;
            Err(std::io::Error::other(
                "stable file identity is unsupported on this platform",
            ))
        }
    }

    fn fingerprint_component(&self) -> String {
        #[cfg(unix)]
        {
            format!("{}:{}", self.dev, self.ino)
        }
        #[cfg(windows)]
        {
            let file_id = self
                .file_id
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("{}:{file_id}", self.volume_serial_number)
        }
        #[cfg(not(any(unix, windows)))]
        {
            unreachable!("unsupported platforms never produce a stable identity")
        }
    }
}

fn stable_directory_identity(path: &Path) -> std::io::Result<FileIdentity> {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_dir() {
            return Err(std::io::Error::other("not a directory"));
        }
        Ok(FileIdentity::from_metadata(&metadata))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };

        let mut options = OpenOptions::new();
        options
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let file = options.open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::other("not a stable non-reparse directory"));
        }
        FileIdentity::from_file(&file)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(std::io::Error::other(
            "stable directory identity is unsupported on this platform",
        ))
    }
}

fn stable_regular_path_identity(path: &Path) -> std::io::Result<FileIdentity> {
    let file = open_regular_nonblocking_nofollow(path)?;
    FileIdentity::from_file(&file)
}

#[derive(Debug)]
struct CodexArtifact {
    canonical_path: PathBuf,
    identity: FileIdentity,
}

enum Inspection {
    Owned(CodexArtifact),
    Unowned,
}

fn inspect_codex_rollout(
    canonical_path: &Path,
    expected_session_id: &str,
) -> Result<Inspection, ExactRecoveryIssue> {
    let file = open_regular_nonblocking_nofollow(canonical_path)
        .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    let before = file
        .metadata()
        .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    if !before.is_file() {
        return Err(ExactRecoveryIssue::StoreReadFailed);
    }
    let identity =
        FileIdentity::from_file(&file).map_err(|_| ExactRecoveryIssue::StoreReadFailed)?;
    let decoded_identity =
        if canonical_path.extension().and_then(|value| value.to_str()) == Some("zst") {
            let mut decoder = zstd::stream::read::Decoder::new(
                file.try_clone()
                    .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?
                    .take(MAX_COMPRESSED_METADATA_BYTES + 1),
            )
            .map_err(|_| ExactRecoveryIssue::ArtifactIncomplete)?;
            decoder
                .window_log_max(ZSTD_MAX_WINDOW_LOG)
                .map_err(|_| ExactRecoveryIssue::ArtifactIncomplete)?;
            read_codex_identity(decoder)?
        } else {
            read_codex_identity(
                file.try_clone()
                    .map_err(|_| ExactRecoveryIssue::StoreReadFailed)?,
            )?
        };
    if !FileIdentity::from_file(&file).is_ok_and(|current| current == identity)
        || !stable_regular_path_identity(canonical_path).is_ok_and(|current| current == identity)
    {
        return Err(ExactRecoveryIssue::ArtifactChanged);
    }
    if decoded_identity == expected_session_id {
        Ok(Inspection::Owned(CodexArtifact {
            canonical_path: canonical_path.to_path_buf(),
            identity,
        }))
    } else {
        Ok(Inspection::Unowned)
    }
}

fn read_codex_identity(reader: impl Read) -> Result<String, ExactRecoveryIssue> {
    let reader = BufReader::new(reader);
    let mut limited = reader.take(MAX_METADATA_BYTES + 1);
    let mut line = Vec::new();
    for _ in 0..MAX_METADATA_RECORDS {
        line.clear();
        let bytes = limited
            .read_until(b'\n', &mut line)
            .map_err(|_| ExactRecoveryIssue::ArtifactIncomplete)?;
        if bytes == 0 {
            return Err(ExactRecoveryIssue::ArtifactIncomplete);
        }
        if line.len() as u64 > MAX_METADATA_BYTES || line.last() != Some(&b'\n') {
            return Err(ExactRecoveryIssue::ArtifactIncomplete);
        }
        let trimmed = line
            .strip_suffix(b"\n")
            .and_then(|line| line.strip_suffix(b"\r").or(Some(line)))
            .unwrap_or(&line);
        if trimmed.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(trimmed) else {
            // Native Codex skips complete malformed/unknown leading records.
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if !record.get("timestamp").is_some_and(Value::is_string)
                    || record
                        .get("ordinal")
                        .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
                {
                    return Err(ExactRecoveryIssue::ArtifactIncomplete);
                }
                let Some(payload) = record.get("payload").and_then(Value::as_object) else {
                    return Err(ExactRecoveryIssue::ArtifactIncomplete);
                };
                if !valid_codex_session_meta_payload(payload) {
                    return Err(ExactRecoveryIssue::ArtifactIncomplete);
                }
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or(ExactRecoveryIssue::ArtifactIncomplete)?;
                let cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|cwd| !cwd.is_empty())
                    .ok_or(ExactRecoveryIssue::ArtifactIncomplete)?;
                let _ = cwd;
                let canonical = freshell_recovery::validate_session_ref(
                    "codex",
                    &SessionLocator {
                        provider: "codex".to_string(),
                        session_id: id.to_string(),
                    },
                )
                .map_err(|_| ExactRecoveryIssue::ArtifactIncomplete)?;
                return Ok(canonical.session_id);
            }
            Some("response_item") | Some("inter_agent_communication") => {
                return Err(ExactRecoveryIssue::ArtifactIncomplete);
            }
            // These are Codex's explicitly permitted leading rollout records.
            Some("event_msg")
            | Some("compacted")
            | Some("turn_context")
            | Some("world_state")
            | Some("inter_agent_communication_metadata")
            | Some(_) => {}
            None => {}
        }
    }
    Err(ExactRecoveryIssue::ArtifactIncomplete)
}

fn valid_codex_session_meta_payload(payload: &Map<String, Value>) -> bool {
    for required in ["id", "timestamp", "cwd", "originator", "cli_version"] {
        if !payload.get(required).is_some_and(Value::is_string) {
            return false;
        }
    }
    if !payload
        .get("id")
        .is_some_and(valid_codex_session_id_value)
        || !valid_default_field(payload, "session_id", valid_codex_session_id_value)
        || !["forked_from_id", "parent_thread_id"]
            .into_iter()
            .all(|key| valid_optional_field(payload, key, valid_codex_session_id_value))
    {
        return false;
    }
    if ![
        "agent_nickname",
        "agent_role",
        "agent_type",
        "agent_path",
        "model_provider",
        "memory_mode",
    ]
    .into_iter()
    .all(|key| valid_optional_field(payload, key, Value::is_string))
    {
        return false;
    }
    if !valid_default_field(payload, "source", valid_codex_session_source)
        || !valid_optional_field(payload, "thread_source", Value::is_string)
        || !valid_optional_field(payload, "base_instructions", valid_base_instructions)
        || !valid_optional_field(payload, "dynamic_tools", valid_dynamic_tools)
        || !valid_default_field(
            payload,
            "selected_capability_roots",
            valid_selected_capability_roots,
        )
        || !valid_default_field(payload, "history_mode", |value| {
            value
                .as_str()
                .is_some_and(|mode| matches!(mode, "legacy" | "paginated"))
        })
        || !valid_optional_field(payload, "history_base", valid_history_position)
        || !valid_optional_field(
            payload,
            "subagent_history_start_ordinal",
            |value| value.as_u64().is_some(),
        )
        || !valid_optional_field(payload, "multi_agent_version", |value| {
            value
                .as_str()
                .is_some_and(|version| matches!(version, "disabled" | "v1" | "v2"))
        })
        || !valid_optional_field(payload, "context_window", |value| {
            value
                .as_object()
                .and_then(|object| object.get("window_id"))
                .is_some_and(Value::is_string)
        })
        || !valid_optional_field(payload, "git", valid_git_info)
    {
        return false;
    }
    true
}

fn valid_default_field(
    payload: &Map<String, Value>,
    key: &str,
    validate: impl Fn(&Value) -> bool,
) -> bool {
    payload.get(key).is_none_or(validate)
}

fn valid_optional_field(
    payload: &Map<String, Value>,
    key: &str,
    validate: impl Fn(&Value) -> bool,
) -> bool {
    payload
        .get(key)
        .is_none_or(|value| value.is_null() || validate(value))
}

fn valid_codex_session_id_value(value: &Value) -> bool {
    value.as_str().is_some_and(|session_id| {
        freshell_recovery::validate_session_ref(
            "codex",
            &SessionLocator {
                provider: "codex".to_string(),
                session_id: session_id.to_string(),
            },
        )
        .is_ok()
    })
}

fn valid_codex_session_source(value: &Value) -> bool {
    if value.is_string() {
        return true;
    }
    let Some(source) = value.as_object().filter(|source| source.len() == 1) else {
        return false;
    };
    if source.get("custom").is_some_and(Value::is_string) {
        return true;
    }
    if source
        .get("internal")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "memory_consolidation")
    {
        return true;
    }
    source.get("subagent").is_some_and(valid_subagent_source)
}

fn valid_subagent_source(value: &Value) -> bool {
    if value
        .as_str()
        .is_some_and(|kind| matches!(kind, "review" | "compact" | "memory_consolidation"))
    {
        return true;
    }
    let Some(source) = value.as_object().filter(|source| source.len() == 1) else {
        return false;
    };
    if source.get("other").is_some_and(Value::is_string) {
        return true;
    }
    let Some(spawn) = source.get("thread_spawn").and_then(Value::as_object) else {
        return false;
    };
    spawn
        .get("parent_thread_id")
        .is_some_and(valid_codex_session_id_value)
        && spawn.get("depth").and_then(Value::as_i64).is_some()
        && valid_optional_field(spawn, "agent_path", |value| {
            value.as_str().is_some_and(|path| path.starts_with('/'))
        })
        && valid_optional_field(spawn, "agent_nickname", Value::is_string)
        && valid_optional_field(spawn, "agent_role", Value::is_string)
        && valid_optional_field(spawn, "agent_type", Value::is_string)
}

fn valid_base_instructions(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|base| base.get("text"))
        .is_some_and(Value::is_string)
}

fn valid_dynamic_tools(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|tools| tools.iter().all(valid_dynamic_tool))
}

fn valid_dynamic_tool(value: &Value) -> bool {
    let Some(tool) = value.as_object() else {
        return false;
    };
    match tool.get("type").and_then(Value::as_str) {
        Some("function") => valid_dynamic_function(tool),
        Some("namespace") => {
            tool.get("name").is_some_and(Value::is_string)
                && tool.get("description").is_some_and(Value::is_string)
                && tool
                    .get("tools")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| {
                        tools.iter().all(|tool| {
                            let Some(tool) = tool.as_object() else {
                                return false;
                            };
                            tool.get("type").and_then(Value::as_str) == Some("function")
                                && valid_dynamic_function(tool)
                        })
                    })
        }
        None => {
            valid_dynamic_function(tool)
                && valid_optional_field(tool, "namespace", Value::is_string)
                && valid_optional_field(tool, "exposeToContext", Value::is_boolean)
        }
        Some(_) => false,
    }
}

fn valid_dynamic_function(tool: &Map<String, Value>) -> bool {
    tool.get("name").is_some_and(Value::is_string)
        && tool.get("description").is_some_and(Value::is_string)
        && tool.contains_key("inputSchema")
        && valid_default_field(tool, "deferLoading", Value::is_boolean)
}

fn valid_selected_capability_roots(value: &Value) -> bool {
    value.as_array().is_some_and(|roots| {
        roots.iter().all(|root| {
            let Some(root) = root.as_object() else {
                return false;
            };
            let Some(location) = root.get("location").and_then(Value::as_object) else {
                return false;
            };
            root.get("id").is_some_and(Value::is_string)
                && location.get("type").and_then(Value::as_str) == Some("environment")
                && location.get("environmentId").is_some_and(Value::is_string)
                && location.get("path").is_some_and(Value::is_string)
        })
    })
}

fn valid_history_position(value: &Value) -> bool {
    let Some(position) = value.as_object() else {
        return false;
    };
    position
        .get("thread_id")
        .is_some_and(valid_codex_session_id_value)
        && position
            .get("end_ordinal_exclusive")
            .and_then(Value::as_u64)
            .is_some()
        && position
            .get("end_byte_offset")
            .and_then(Value::as_u64)
            .is_some()
}

fn valid_git_info(value: &Value) -> bool {
    value.as_object().is_some_and(|git| {
        ["commit_hash", "branch", "repository_url"]
            .into_iter()
            .all(|key| valid_optional_field(git, key, Value::is_string))
    })
}

fn present_codex_state(
    roots: &CodexBatchRoots,
    session_id: &str,
    artifact: &CodexArtifact,
) -> ExactRecoveryState {
    let session_ref = SessionLocator {
        provider: "codex".to_string(),
        session_id: session_id.to_string(),
    };
    let Some(artifact_fingerprint) = codex_fingerprint(roots, artifact) else {
        return ExactRecoveryState::Retryable(ExactRecoveryIssue::StoreReadFailed);
    };
    ExactRecoveryState::Present(ExactRecoveryProof {
        owner_key: RecoveryOwnerKey::global(&session_ref).expect("validated global Codex owner"),
        artifact_fingerprint,
        resolved_cwd: None,
    })
}

fn codex_fingerprint(roots: &CodexBatchRoots, artifact: &CodexArtifact) -> Option<String> {
    let rollout_root = roots
        .canonical_rollout_roots()
        .filter(|root| artifact.canonical_path.starts_with(root))
        .max_by_key(|root| root.components().count())?;
    let relative = artifact.canonical_path.strip_prefix(rollout_root).ok()?;
    Some(format!(
        "codex:{}:{}:{}:{}:{}:{}",
        roots.codex_home.fingerprint_component(),
        roots.sqlite_home.fingerprint_component(),
        roots.rollout_roots[0].fingerprint_component(),
        roots.rollout_roots[1].fingerprint_component(),
        relative.to_string_lossy(),
        artifact.identity.fingerprint_component()
    ))
}

fn open_regular_nonblocking_nofollow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT,
        };

        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(not(any(unix, windows)))]
    {
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(std::io::Error::other("not a regular no-follow file"));
        }
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::other("not a regular non-reparse file"));
        }
    }
    if !metadata.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_recovery::MaterializationState;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "freshell-codex-root-race-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("create temp tree");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn metadata_line(session_id: &str) -> String {
        format!(
            "{{\"timestamp\":\"2026-07-29T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"timestamp\":\"2026-07-29T00:00:00Z\",\"cwd\":\"/workspace\",\"originator\":\"codex_cli_rs\",\"cli_version\":\"0.145.0\"}}}}\n"
        )
    }

    #[test]
    fn replacing_rollout_root_before_batch_return_is_artifact_changed() {
        let tree = TempTree::new();
        let codex_home = tree.0.join("codex");
        let sqlite_home = tree.0.join("state");
        let active = codex_home.join(ACTIVE_SUBDIR);
        let session_id = "70000000-0000-4000-8000-000000000021";
        let rollout = active.join(format!("rollout-{session_id}.jsonl"));
        std::fs::create_dir_all(&active).expect("create active root");
        std::fs::create_dir_all(&sqlite_home).expect("create state root");
        std::fs::write(&rollout, metadata_line(session_id)).expect("write rollout");
        let query = freshell_recovery::prepare_exact_recovery_query(
            "codex",
            &SessionLocator {
                provider: "codex".to_string(),
                session_id: session_id.to_string(),
            },
            None,
            MaterializationState::Observed,
        )
        .expect("valid query");
        let store = CodexExactStore {
            codex_home,
            sqlite_home,
        };
        let replaced = tree.0.join("old-sessions");

        let snapshot = lookup_codex_exact_many_in_store_with_root_recheck_hook(
            &store,
            std::slice::from_ref(&query),
            || {
                std::fs::rename(&active, &replaced).expect("move captured root");
                std::fs::create_dir_all(&active).expect("replace captured root");
            },
        );

        assert!(matches!(
            snapshot.get(&query.key).map(|result| &result.state),
            Some(ExactRecoveryState::Retryable(
                ExactRecoveryIssue::ArtifactChanged
            ))
        ));
    }
}
