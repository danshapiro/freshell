//! Read-only authority for restoring an existing host OpenCode conversation.
//!
//! The host CLI selects its own default store. Resuming against an empty soul
//! volume is not restoration, and OPENCODE_DB is not a CLI store-selection API.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

const SOURCE_ENV: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_DB",
    "OPENCODE_TEST_HOME",
];
const MAX_CHANNEL_ENTRIES: usize = 256;
const MAX_CHANNEL_DATABASES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOpenCodeRestoreError {
    Missing,
    Ambiguous,
    Unreadable,
    IdentityMismatch,
    CwdMismatch,
    UnsupportedEnvironment,
    Stale,
}

impl HostOpenCodeRestoreError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Missing => "native_history_missing",
            Self::Ambiguous => "native_history_ambiguous",
            Self::Unreadable => "native_history_unreadable",
            Self::IdentityMismatch => "native_history_identity_mismatch",
            Self::CwdMismatch => "native_history_cwd_mismatch",
            Self::UnsupportedEnvironment => "native_history_environment_unsupported",
            Self::Stale => "native_history_changed",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct NativeIdentity {
    id: String,
    directory: String,
    project_id: String,
    workspace_id: Option<String>,
    time_created: i64,
}

#[derive(Debug)]
pub struct HostOpenCodeRestoreSource {
    pub database_path: PathBuf,
    pub cwd: PathBuf,
    identity: NativeIdentity,
    environment: BTreeMap<String, Option<OsString>>,
    // Keep the file open: a path replacement must not compare as the old file
    // even if the filesystem could otherwise reuse its inode/file ID.
    file: same_file::Handle,
}

impl HostOpenCodeRestoreSource {
    /// Re-derive the exact selected row and CLI environment after MCP setup,
    /// immediately before ordinary owned PTY creation. Unrelated WAL writes and
    /// mutable titles are deliberately not part of the conversation identity.
    pub fn revalidate(
        &self,
        child_environment: &BTreeMap<String, String>,
    ) -> Result<(), HostOpenCodeRestoreError> {
        if self.environment != source_environment()
            || self.environment.iter().any(|(name, value)| {
                value.as_deref() != child_environment.get(name).map(std::ffi::OsStr::new)
            })
        {
            return Err(HostOpenCodeRestoreError::Stale);
        }
        let current = locate_host_opencode_restore(&self.identity.id, Some(&self.cwd))?;
        if self.database_path != current.database_path
            || self.cwd != current.cwd
            || self.identity != current.identity
            || self.file != current.file
        {
            return Err(HostOpenCodeRestoreError::Stale);
        }
        Ok(())
    }
}

fn source_environment() -> BTreeMap<String, Option<OsString>> {
    SOURCE_ENV
        .iter()
        .map(|name| ((*name).to_string(), std::env::var_os(name)))
        .collect()
}

pub fn locate_host_opencode_restore(
    session_id: &str,
    requested_cwd: Option<&Path>,
) -> Result<HostOpenCodeRestoreSource, HostOpenCodeRestoreError> {
    if !session_id.starts_with("ses_")
        || session_id.len() > 128
        || session_id.len() <= 4
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(HostOpenCodeRestoreError::IdentityMismatch);
    }
    let environment = source_environment();
    if ["OPENCODE_DB", "OPENCODE_TEST_HOME"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
    {
        return Err(HostOpenCodeRestoreError::UnsupportedEnvironment);
    }
    let data_home = freshell_sessions::parse::default_opencode_data_home();
    if !data_home.is_absolute() {
        return Err(HostOpenCodeRestoreError::UnsupportedEnvironment);
    }
    let database_path = data_home.join("opencode.db");
    let (identity, file) =
        read_identity(&database_path, session_id)?.ok_or(HostOpenCodeRestoreError::Missing)?;
    let mut channels = 0;
    for (index, entry) in fs::read_dir(&data_home)
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?
        .enumerate()
    {
        if index >= MAX_CHANNEL_ENTRIES {
            return Err(HostOpenCodeRestoreError::Unreadable);
        }
        let entry = entry.map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "opencode.db" || !name.starts_with("opencode-") || !name.ends_with(".db") {
            continue;
        }
        channels += 1;
        if channels > MAX_CHANNEL_DATABASES {
            return Err(HostOpenCodeRestoreError::Unreadable);
        }
        if read_identity(&entry.path(), session_id)?.is_some() {
            return Err(HostOpenCodeRestoreError::Ambiguous);
        }
    }
    let cwd =
        fs::canonicalize(&identity.directory).map_err(|_| HostOpenCodeRestoreError::CwdMismatch)?;
    if !cwd.is_dir()
        || requested_cwd
            .is_some_and(|requested| fs::canonicalize(requested).ok().as_ref() != Some(&cwd))
    {
        return Err(HostOpenCodeRestoreError::CwdMismatch);
    }
    if environment != source_environment() {
        return Err(HostOpenCodeRestoreError::Stale);
    }
    Ok(HostOpenCodeRestoreSource {
        database_path,
        cwd,
        identity,
        environment,
        file,
    })
}

fn read_identity(
    path: &Path,
    session_id: &str,
) -> Result<Option<(NativeIdentity, same_file::Handle)>, HostOpenCodeRestoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(HostOpenCodeRestoreError::Unreadable),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(HostOpenCodeRestoreError::Unreadable);
    }
    let file =
        same_file::Handle::from_path(path).map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    // Refuse an unindexed/lookalike schema rather than scanning a large store.
    let plan: String = connection
        .query_row(
            "EXPLAIN QUERY PLAN SELECT id FROM session WHERE id=?1",
            [session_id],
            |row| row.get(3),
        )
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    if !plan.starts_with("SEARCH ") {
        return Err(HostOpenCodeRestoreError::Unreadable);
    }
    let mut statement = connection.prepare(
        "SELECT id,substr(directory,1,4097),substr(project_id,1,4097),substr(workspace_id,1,4097),time_created FROM session WHERE id=?1 LIMIT 2",
    ).map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    let mut rows = statement
        .query_map([session_id], |row| {
            Ok(NativeIdentity {
                id: row.get(0)?,
                directory: row.get(1)?,
                project_id: row.get(2)?,
                workspace_id: row.get(3)?,
                time_created: row.get(4)?,
            })
        })
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    let identity = rows
        .next()
        .transpose()
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?;
    if rows
        .next()
        .transpose()
        .map_err(|_| HostOpenCodeRestoreError::Unreadable)?
        .is_some()
    {
        return Err(HostOpenCodeRestoreError::Ambiguous);
    }
    if identity.as_ref().is_some_and(|row| {
        row.directory.len() > 4096
            || row.project_id.len() > 4096
            || row
                .workspace_id
                .as_ref()
                .is_some_and(|value| value.len() > 4096)
    }) {
        return Err(HostOpenCodeRestoreError::Unreadable);
    }
    let current =
        same_file::Handle::from_path(path).map_err(|_| HostOpenCodeRestoreError::Stale)?;
    if file != current {
        return Err(HostOpenCodeRestoreError::Stale);
    }
    Ok(identity.map(|value| (value, file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_duplicate_native_rows_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("opencode.db");
        let database = Connection::open(&path).unwrap();
        database.execute_batch("CREATE TABLE session(id TEXT, directory TEXT, project_id TEXT, workspace_id TEXT, time_created INTEGER); CREATE INDEX session_id ON session(id); INSERT INTO session VALUES('ses_duplicate','/project','one',NULL,1),('ses_duplicate','/project','two',NULL,2);").unwrap();
        assert!(matches!(
            read_identity(&path, "ses_duplicate"),
            Err(HostOpenCodeRestoreError::Ambiguous)
        ));
    }
}
