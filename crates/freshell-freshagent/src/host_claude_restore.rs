//! Narrow host-store authority for a legacy Claude terminal restore.
//!
//! Configuration staging deliberately excludes native history. An existing
//! host conversation must keep its selected native root, rather than resuming
//! the same UUID against an unrelated empty managed provider volume.

use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const HEADER_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostClaudeRestoreError {
    Missing,
    Ambiguous,
    Unreadable,
    IdentityMismatch,
    CwdMismatch,
    Stale,
}

impl HostClaudeRestoreError {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Missing => "native_history_missing",
            Self::Ambiguous => "native_history_ambiguous",
            Self::Unreadable => "native_history_unreadable",
            Self::IdentityMismatch => "native_history_identity_mismatch",
            Self::CwdMismatch => "native_history_cwd_mismatch",
            Self::Stale => "native_history_changed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceStamp {
    length: u64,
    modified: SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl SourceStamp {
    fn read(metadata: &Metadata) -> Result<Self, HostClaudeRestoreError> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(HostClaudeRestoreError::Unreadable);
        }
        Ok(Self {
            length: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|_| HostClaudeRestoreError::Unreadable)?,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostClaudeRestoreSource {
    pub config_root: PathBuf,
    pub transcript_path: PathBuf,
    pub cwd: PathBuf,
    session_id: String,
    roots: Vec<PathBuf>,
    stamp: SourceStamp,
}

impl HostClaudeRestoreSource {
    /// Repeat the exact source selection immediately before the owned spawn.
    /// A new collision, source replacement, or changed transcript cannot
    /// silently authorize another route or a fresh conversation.
    pub fn revalidate(&self) -> Result<(), HostClaudeRestoreError> {
        let current = locate_in(&self.roots, &self.session_id, Some(&self.cwd))?;
        if &current == self {
            Ok(())
        } else {
            Err(HostClaudeRestoreError::Stale)
        }
    }
}

pub fn locate_host_claude_restore(
    session_id: &str,
    requested_cwd: Option<&Path>,
) -> Result<HostClaudeRestoreSource, HostClaudeRestoreError> {
    // This is the existing selected native-root authority used by attach,
    // snapshots, naming, and the server's disk-existence probe.
    locate_in(
        &crate::claude_snapshot::claude_home_candidates(),
        session_id,
        requested_cwd,
    )
}

fn locate_in(
    roots: &[PathBuf],
    session_id: &str,
    requested_cwd: Option<&Path>,
) -> Result<HostClaudeRestoreSource, HostClaudeRestoreError> {
    if uuid::Uuid::parse_str(session_id)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        != Some(session_id)
    {
        return Err(HostClaudeRestoreError::IdentityMismatch);
    }
    let mut selected = None;
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let projects = root.join("projects");
        let entries = match fs::read_dir(&projects) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(HostClaudeRestoreError::Unreadable),
        };
        for entry in entries {
            let entry = entry.map_err(|_| HostClaudeRestoreError::Unreadable)?;
            let path = entry.path().join(format!("{session_id}.jsonl"));
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
                {
                    continue
                }
                Err(_) => return Err(HostClaudeRestoreError::Unreadable),
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(HostClaudeRestoreError::Unreadable);
            }
            let config_root =
                fs::canonicalize(root).map_err(|_| HostClaudeRestoreError::Unreadable)?;
            let transcript_path =
                fs::canonicalize(path).map_err(|_| HostClaudeRestoreError::Unreadable)?;
            if !transcript_path.starts_with(config_root.join("projects")) {
                return Err(HostClaudeRestoreError::Unreadable);
            }
            if !seen.insert(transcript_path.clone()) {
                continue;
            }
            if selected.is_some() {
                return Err(HostClaudeRestoreError::Ambiguous);
            }
            let mut file =
                File::open(&transcript_path).map_err(|_| HostClaudeRestoreError::Unreadable)?;
            let stamp = SourceStamp::read(
                &file
                    .metadata()
                    .map_err(|_| HostClaudeRestoreError::Unreadable)?,
            )?;
            let mut prefix = Vec::new();
            (&mut file)
                .take(HEADER_BYTES)
                .read_to_end(&mut prefix)
                .map_err(|_| HostClaudeRestoreError::Unreadable)?;
            let mut cwd = None;
            let mut identity_verified = false;
            for line in prefix.split_inclusive(|byte| *byte == b'\n') {
                if !line.ends_with(b"\n") {
                    break;
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let row: serde_json::Value =
                    serde_json::from_slice(line).map_err(|_| HostClaudeRestoreError::Unreadable)?;
                if let Some(id) = row.get("sessionId").and_then(serde_json::Value::as_str) {
                    if id != session_id {
                        return Err(HostClaudeRestoreError::IdentityMismatch);
                    }
                    identity_verified = true;
                    if cwd.is_none() {
                        cwd = row
                            .get("cwd")
                            .and_then(serde_json::Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(PathBuf::from);
                    }
                }
            }
            if !identity_verified {
                return Err(HostClaudeRestoreError::IdentityMismatch);
            }
            let cwd = fs::canonicalize(cwd.ok_or(HostClaudeRestoreError::CwdMismatch)?)
                .map_err(|_| HostClaudeRestoreError::CwdMismatch)?;
            if !cwd.is_dir()
                || requested_cwd.is_some_and(|requested| {
                    fs::canonicalize(requested).ok().as_ref() != Some(&cwd)
                })
            {
                return Err(HostClaudeRestoreError::CwdMismatch);
            }
            if SourceStamp::read(
                &file
                    .metadata()
                    .map_err(|_| HostClaudeRestoreError::Unreadable)?,
            )? != stamp
            {
                return Err(HostClaudeRestoreError::Stale);
            }
            selected = Some(HostClaudeRestoreSource {
                config_root,
                transcript_path,
                cwd,
                session_id: session_id.into(),
                roots: roots.to_vec(),
                stamp,
            });
        }
    }
    selected.ok_or(HostClaudeRestoreError::Missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "11111111-2222-4333-8444-555566667777";

    #[test]
    fn verified_host_source_refuses_replacement_changes_and_new_collisions() {
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("native-root");
        let project = root.join("projects/original");
        let cwd = owned.path().join("workspace");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let path = project.join(format!("{SESSION}.jsonl"));
        let bytes = format!(
            "{}\n",
            serde_json::json!({"sessionId":SESSION,"cwd":cwd,"type":"user"})
        );
        fs::write(&path, &bytes).unwrap();
        let source = locate_in(std::slice::from_ref(&root), SESSION, Some(&cwd)).unwrap();
        assert_eq!(source.revalidate(), Ok(()));
        fs::rename(&path, project.join("original-preserved.jsonl")).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert_eq!(source.revalidate(), Err(HostClaudeRestoreError::Stale));
        let source = locate_in(std::slice::from_ref(&root), SESSION, Some(&cwd)).unwrap();
        fs::write(&path, format!("{bytes}{bytes}")).unwrap();
        assert_eq!(source.revalidate(), Err(HostClaudeRestoreError::Stale));
        let source = locate_in(std::slice::from_ref(&root), SESSION, Some(&cwd)).unwrap();
        let duplicate = root.join("projects/duplicate");
        fs::create_dir_all(&duplicate).unwrap();
        fs::write(duplicate.join(format!("{SESSION}.jsonl")), bytes).unwrap();
        assert_eq!(source.revalidate(), Err(HostClaudeRestoreError::Ambiguous));
    }
}
