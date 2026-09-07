use freshell_runtime_protocol::{CommandState, RequestId, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRecord {
    payload_digest: String,
    state: CommandState,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFile {
    commands: BTreeMap<String, CommandRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginDisposition {
    Dispatch,
    Completed,
    Ambiguous,
}

pub struct CommandJournal {
    path: PathBuf,
    file: JournalFile,
}

impl CommandJournal {
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(state_dir).map_err(|e| e.to_string())?;
        let path = state_dir.join("command-journal.json");
        let mut file: JournalFile = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            JournalFile::default()
        };
        let mut changed = false;
        for record in file.commands.values_mut() {
            if record.state == CommandState::Dispatching
                || record.state == CommandState::ProviderAcked
            {
                record.state = CommandState::Ambiguous;
                changed = true;
            }
        }
        let journal = Self { path, file };
        if changed {
            journal.persist()?;
        }
        Ok(journal)
    }

    pub fn begin(
        &mut self,
        request_id: &RequestId,
        payload: &[u8],
    ) -> Result<BeginDisposition, RuntimeError> {
        let digest = format!("sha256:{:x}", Sha256::digest(payload));
        if let Some(record) = self.file.commands.get(request_id.as_str()) {
            if record.payload_digest != digest {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::RequestIdConflict,
                    "input request id reused with different payload",
                ));
            }
            return Ok(match record.state {
                CommandState::Completed | CommandState::Cancelled => BeginDisposition::Completed,
                CommandState::Ambiguous
                | CommandState::Dispatching
                | CommandState::ProviderAcked => BeginDisposition::Ambiguous,
                CommandState::Queued => BeginDisposition::Dispatch,
            });
        }
        self.file.commands.insert(
            request_id.to_string(),
            CommandRecord {
                payload_digest: digest,
                state: CommandState::Queued,
            },
        );
        self.persist().map_err(runtime_io)?;
        Ok(BeginDisposition::Dispatch)
    }

    pub fn mark_dispatching(&mut self, request_id: &RequestId) -> Result<(), RuntimeError> {
        self.set_state(request_id, CommandState::Dispatching)
    }

    pub fn mark_completed(&mut self, request_id: &RequestId) -> Result<(), RuntimeError> {
        self.set_state(request_id, CommandState::Completed)
    }

    fn set_state(
        &mut self,
        request_id: &RequestId,
        state: CommandState,
    ) -> Result<(), RuntimeError> {
        let record = self
            .file
            .commands
            .get_mut(request_id.as_str())
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "unknown command request id",
                )
            })?;
        record.state = state;
        self.persist().map_err(runtime_io)
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("tmp");
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).write(true).truncate(true);
        let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn runtime_io(error: String) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RegistryFailure, error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_is_deduped_and_conflicting_payload_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let id = RequestId::new();
        let mut journal = CommandJournal::open(dir.path()).unwrap();
        assert_eq!(
            journal.begin(&id, b"echo one").unwrap(),
            BeginDisposition::Dispatch
        );
        journal.mark_dispatching(&id).unwrap();
        journal.mark_completed(&id).unwrap();
        assert_eq!(
            journal.begin(&id, b"echo one").unwrap(),
            BeginDisposition::Completed
        );
        let error = journal.begin(&id, b"echo two").unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RequestIdConflict);
    }

    #[test]
    fn dispatching_command_becomes_ambiguous_after_host_restart() {
        let dir = tempfile::tempdir().unwrap();
        let id = RequestId::new();
        let mut journal = CommandJournal::open(dir.path()).unwrap();
        journal.begin(&id, b"x").unwrap();
        journal.mark_dispatching(&id).unwrap();
        drop(journal);
        let mut reopened = CommandJournal::open(dir.path()).unwrap();
        assert_eq!(
            reopened.begin(&id, b"x").unwrap(),
            BeginDisposition::Ambiguous
        );
    }
}
