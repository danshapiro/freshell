//! Per-unit records: the only persisted unit state, and the only way a
//! restarted server finds units. Each record lives in
//! `<state_root>/units/<unit id>.json` and is owned by the server process
//! that wrote it: the store locks `<unit id>.lock` before the record's first
//! write and holds it until the record is deleted at Gone or the process
//! exits, so a record whose lock is free belongs to no running server. Two
//! servers on one state root each record their own units and never load a
//! record the other still holds.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::UnitId;

/// One unit as persisted. Persisted Stopping lives ONLY here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UnitRecord {
    pub unit_id: UnitId,
    pub provider: String,
    pub mode: String,
    pub terminal_id: Option<String>,
    pub create_request_id: Option<String>,
    /// (provider, session id) of every conversation the unit holds.
    pub conversation_keys: Vec<(String, String)>,
    /// The current pinned roots as (pid, start time); a restarted server
    /// signals only processes whose pid AND start time still match.
    pub roots: Vec<(u32, u64)>,
    pub state: UnitRecordState,
    /// A pre-containment (v1) Codex sidecar adopted by
    /// `Containment::adopt_legacy`: the environment tag `(key, value)` its
    /// processes carry. A reopen finds the unit's members by this tag, its
    /// live roots and their descendants, as the adoption did. `None` for
    /// every unit this server created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_tag: Option<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UnitRecordState {
    Running,
    Stopping {
        reason: String,
        operation_id: Option<String>,
        since_ms: u64,
    },
}

/// The record store of one `Containment`.
pub(crate) struct RecordStore {
    kind: StoreKind,
    /// Every record this store owns now (loaded at open, or written since),
    /// with the lock that marks ownership on disk.
    owned: Mutex<BTreeMap<UnitId, Owned>>,
    /// Tests: how many record writes were asked of this store.
    #[cfg(test)]
    writes: std::sync::atomic::AtomicUsize,
}

enum StoreKind {
    /// Tests only (an empty state root): records live in memory.
    Memory,
    Disk {
        dir: PathBuf,
    },
    /// `<state_root>/units/` could not be created: every write fails.
    Unavailable {
        dir: PathBuf,
        cause: String,
    },
}

struct Owned {
    record: UnitRecord,
    /// Held for the record's lifetime (`None` in memory).
    lock: Option<File>,
}

impl RecordStore {
    /// Opens the store for `state_root` and takes ownership of every record
    /// no running server holds (boot). An empty root gives the in-memory
    /// store (tests only).
    pub(crate) fn open(state_root: &Path) -> Self {
        if state_root.as_os_str().is_empty() {
            return Self {
                kind: StoreKind::Memory,
                owned: Mutex::new(BTreeMap::new()),
                #[cfg(test)]
                writes: Default::default(),
            };
        }
        let dir = state_root.join("units");
        if let Err(err) = std::fs::create_dir_all(&dir) {
            tracing::error!(target: "freshell_unit",
                event = "containment.unit_store_unavailable",
                path = %dir.display(),
                cause = %err,
                "unit record store unavailable: coding-agent starts will fail");
            return Self {
                kind: StoreKind::Unavailable {
                    dir,
                    cause: err.to_string(),
                },
                owned: Mutex::new(BTreeMap::new()),
                #[cfg(test)]
                writes: Default::default(),
            };
        }
        let owned = load_all(&dir);
        Self {
            kind: StoreKind::Disk { dir },
            owned: Mutex::new(owned),
            #[cfg(test)]
            writes: Default::default(),
        }
    }

    /// The records this store owns now: at boot, exactly those no running
    /// server held; later also the units created since (minus deleted ones).
    pub(crate) fn owned_records(&self) -> io::Result<Vec<UnitRecord>> {
        if let StoreKind::Unavailable { .. } = self.kind {
            return Err(self.unavailable());
        }
        Ok(self
            .owned
            .lock()
            .unwrap()
            .values()
            .map(|o| o.record.clone())
            .collect())
    }

    /// Writes `record` atomically (temp file in the same directory, then
    /// rename; no fsync: it only has to survive a server-process crash).
    /// The first write of a unit takes its lock.
    pub(crate) fn write(&self, record: &UnitRecord) -> io::Result<()> {
        #[cfg(test)]
        self.writes
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = match &self.kind {
            StoreKind::Memory => {
                let mut owned = self.owned.lock().unwrap();
                owned.insert(
                    record.unit_id.clone(),
                    Owned {
                        record: record.clone(),
                        lock: None,
                    },
                );
                return Ok(());
            }
            StoreKind::Unavailable { .. } => return Err(self.unavailable()),
            StoreKind::Disk { dir } => dir,
        };
        let mut owned = self.owned.lock().unwrap();
        if let Some(entry) = owned.get_mut(&record.unit_id) {
            // On failure the previous record stays on disk and owned.
            write_atomically(dir, record)?;
            entry.record = record.clone();
            return Ok(());
        }
        let lock_file = lock_path(dir, &record.unit_id);
        let lock = take_lock(&lock_file)?;
        if let Err(err) = write_atomically(dir, record) {
            release(lock, &lock_file);
            return Err(err);
        }
        owned.insert(
            record.unit_id.clone(),
            Owned {
                record: record.clone(),
                lock: Some(lock),
            },
        );
        Ok(())
    }

    /// Deletes the record, then releases, closes and deletes its lock.
    pub(crate) fn remove(&self, id: &UnitId) -> io::Result<()> {
        let dir = match &self.kind {
            StoreKind::Memory => {
                self.owned.lock().unwrap().remove(id);
                return Ok(());
            }
            StoreKind::Unavailable { .. } => return Err(self.unavailable()),
            StoreKind::Disk { dir } => dir,
        };
        let mut owned = self.owned.lock().unwrap();
        match std::fs::remove_file(record_path(dir, id)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        if let Some(lock) = owned.remove(id).and_then(|entry| entry.lock) {
            release(lock, &lock_path(dir, id));
        }
        Ok(())
    }

    /// Tests: how many record writes were asked of this store so far.
    #[cfg(test)]
    pub(crate) fn writes(&self) -> usize {
        self.writes.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn unavailable(&self) -> io::Error {
        match &self.kind {
            StoreKind::Unavailable { dir, cause } => io::Error::other(format!(
                "the unit record store {} is unavailable: {cause}",
                dir.display()
            )),
            _ => io::Error::other("the unit record store is available"),
        }
    }
}

/// Ownership of the records ends with the store. The locks are released
/// explicitly: a lock belongs to the open file description, and a child
/// forked by another thread and not yet exec'd holds a copy of every open
/// descriptor, which would otherwise keep the record locked until that child
/// execs.
impl Drop for RecordStore {
    fn drop(&mut self) {
        let owned = self
            .owned
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in owned.values() {
            if let Some(lock) = &entry.lock {
                let _ = lock.unlock();
            }
        }
    }
}

/// Releases and closes a record lock, then deletes its file.
fn release(lock: File, path: &Path) {
    let _ = lock.unlock();
    drop(lock);
    let _ = std::fs::remove_file(path);
}

fn record_path(dir: &Path, id: &UnitId) -> PathBuf {
    dir.join(format!("{}.json", id.as_str()))
}

fn lock_path(dir: &Path, id: &UnitId) -> PathBuf {
    dir.join(format!("{}.lock", id.as_str()))
}

/// Opens (creating it if absent) and exclusively locks `path` without
/// waiting; `WouldBlock` when a running server holds it.
fn take_lock(path: &Path) -> io::Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("{} is held by a running server", path.display()),
        )),
        Err(std::fs::TryLockError::Error(err)) => Err(err),
    }
}

fn write_atomically(dir: &Path, record: &UnitRecord) -> io::Result<()> {
    let json = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
    let tmp = dir.join(format!("{}.tmp", record.unit_id.as_str()));
    let mut file = File::create(&tmp)?;
    file.write_all(&json)?;
    drop(file);
    std::fs::rename(&tmp, record_path(dir, &record.unit_id))
}

/// Boot: takes ownership of every record whose lock no running server
/// holds. A record held elsewhere is skipped unread and silently; one whose
/// lock cannot be taken for any other reason, or that cannot be read, is
/// skipped with a WARN; one that does not parse (a torn write after a
/// machine crash, whose processes died with it) is logged and removed with
/// its lock file. A directory that cannot be listed is logged once (ERROR):
/// none of its records can be finished.
fn load_all(dir: &Path) -> BTreeMap<UnitId, Owned> {
    let mut owned = BTreeMap::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            tracing::error!(target: "freshell_unit",
                event = "containment.unit_records_unlisted",
                path = %dir.display(),
                error = %err,
                "unit records could not be listed: units recorded before this start are not finished");
            return owned;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".json"))
            .and_then(UnitId::parse)
        else {
            continue;
        };
        let lock_file = lock_path(dir, &id);
        let lock = match take_lock(&lock_file) {
            Ok(lock) => lock,
            // Held by a running server: its record, never read.
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => continue,
            Err(err) => {
                tracing::warn!(target: "freshell_unit",
                    event = "containment.unit_record_unlockable",
                    unit_id = %id,
                    path = %lock_file.display(),
                    error = %err,
                    "unit record skipped: its lock could not be taken");
                continue;
            }
        };
        match std::fs::read(&path) {
            Ok(raw) => match serde_json::from_slice::<UnitRecord>(&raw) {
                Ok(record) if record.unit_id == id => {
                    owned.insert(
                        id,
                        Owned {
                            record,
                            lock: Some(lock),
                        },
                    );
                }
                parsed => {
                    let reason = match parsed {
                        Ok(_) => "the record names another unit".to_string(),
                        Err(err) => err.to_string(),
                    };
                    tracing::warn!(target: "freshell_unit",
                        event = "containment.unit_record_unreadable",
                        unit_id = %id,
                        path = %path.display(),
                        error = %reason,
                        removed = true,
                        "unreadable unit record removed");
                    let _ = std::fs::remove_file(&path);
                    release(lock, &lock_file);
                }
            },
            // Deleted by its owner between the listing and the lock.
            Err(err) if err.kind() == io::ErrorKind::NotFound => release(lock, &lock_file),
            Err(err) => {
                tracing::warn!(target: "freshell_unit",
                    event = "containment.unit_record_unreadable",
                    unit_id = %id,
                    path = %path.display(),
                    error = %err,
                    removed = false,
                    "unit record skipped: it could not be read");
                release(lock, &lock_file);
            }
        }
    }
    owned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_capture::{capture, CapturedEvent, FieldValue};

    fn record(state: UnitRecordState) -> UnitRecord {
        UnitRecord {
            unit_id: UnitId::mint(),
            provider: "codex".into(),
            mode: "codex".into(),
            terminal_id: Some("t1".into()),
            create_request_id: None,
            conversation_keys: vec![("codex".into(), "s1".into())],
            roots: vec![(10, 1000)],
            state,
            legacy_tag: None,
        }
    }

    #[test]
    fn the_record_state_is_tagged_by_kind_in_snake_case() {
        let running = serde_json::to_value(record(UnitRecordState::Running)).unwrap();
        assert_eq!(running["state"], serde_json::json!({ "kind": "running" }));
        let stopping = serde_json::to_value(record(UnitRecordState::Stopping {
            reason: "shift-x".into(),
            operation_id: Some("op".into()),
            since_ms: 5,
        }))
        .unwrap();
        assert_eq!(
            stopping["state"],
            serde_json::json!({ "kind": "stopping", "reason": "shift-x", "operation_id": "op", "since_ms": 5 })
        );
    }

    /// `<root>/units` with one valid Running record in it.
    fn units_with_one_record() -> (tempfile::TempDir, PathBuf, UnitRecord) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("units");
        std::fs::create_dir_all(&dir).unwrap();
        let rec = record(UnitRecordState::Running);
        std::fs::write(
            record_path(&dir, &rec.unit_id),
            serde_json::to_vec(&rec).unwrap(),
        )
        .unwrap();
        (root, dir, rec)
    }

    /// Opens the store on `root`, returning it and every event it logged.
    fn open_captured(root: &Path) -> (RecordStore, Vec<CapturedEvent>) {
        let mut store = None;
        let events = capture(|| store = Some(RecordStore::open(root)));
        (store.unwrap(), events)
    }

    #[test]
    fn an_unreadable_record_is_removed_with_its_lock_at_boot() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("units");
        std::fs::create_dir_all(&dir).unwrap();
        let id = UnitId::mint();
        std::fs::write(record_path(&dir, &id), b"{ torn").unwrap();
        std::fs::write(lock_path(&dir, &id), b"").unwrap();
        let (store, events) = open_captured(root.path());
        assert!(store.owned_records().unwrap().is_empty());
        assert!(!record_path(&dir, &id).exists());
        assert!(!lock_path(&dir, &id).exists());
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].level, tracing::Level::WARN);
        assert_eq!(events[0].str("event"), "containment.unit_record_unreadable");
        assert_eq!(events[0].fields["removed"], FieldValue::Bool(true));
    }

    #[test]
    fn a_record_held_by_a_running_server_is_skipped_without_a_log_line() {
        let (root, dir, rec) = units_with_one_record();
        let _held = take_lock(&lock_path(&dir, &rec.unit_id)).unwrap();
        let (store, events) = open_captured(root.path());
        assert!(events.is_empty(), "{events:?}");
        assert!(store.owned_records().unwrap().is_empty());
        assert!(record_path(&dir, &rec.unit_id).exists());
    }

    #[test]
    fn a_record_whose_lock_cannot_be_taken_is_skipped_with_a_warning() {
        let (root, dir, rec) = units_with_one_record();
        // Opening a directory for writing fails (EISDIR), even as root.
        let lock = lock_path(&dir, &rec.unit_id);
        std::fs::create_dir(&lock).unwrap();
        let (store, events) = open_captured(root.path());
        assert!(store.owned_records().unwrap().is_empty());
        assert!(
            record_path(&dir, &rec.unit_id).exists(),
            "never read or removed"
        );
        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event.level, tracing::Level::WARN);
        assert_eq!(event.target, "freshell_unit");
        assert_eq!(event.str("event"), "containment.unit_record_unlockable");
        assert_eq!(event.str("unit_id"), rec.unit_id.as_str());
        assert_eq!(event.str("path"), lock.display().to_string());
        assert!(!event.str("error").is_empty());
    }

    #[test]
    fn a_record_that_cannot_be_read_is_skipped_with_a_warning() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("units");
        std::fs::create_dir_all(&dir).unwrap();
        let id = UnitId::mint();
        // Reading a directory fails (EISDIR), even as root.
        std::fs::create_dir(record_path(&dir, &id)).unwrap();
        let (store, events) = open_captured(root.path());
        assert!(store.owned_records().unwrap().is_empty());
        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event.level, tracing::Level::WARN);
        assert_eq!(event.str("event"), "containment.unit_record_unreadable");
        assert_eq!(event.str("unit_id"), id.as_str());
        assert_eq!(event.fields["removed"], FieldValue::Bool(false));
        assert!(record_path(&dir, &id).exists(), "not removed");
    }

    #[test]
    fn a_units_directory_that_cannot_be_listed_is_logged_once() {
        let root = tempfile::tempdir().unwrap();
        let not_a_dir = root.path().join("units");
        std::fs::write(&not_a_dir, b"a file").unwrap();
        let events = capture(|| {
            assert!(load_all(&not_a_dir).is_empty());
        });
        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event.level, tracing::Level::ERROR);
        assert_eq!(event.target, "freshell_unit");
        assert_eq!(event.str("event"), "containment.unit_records_unlisted");
        assert_eq!(event.str("path"), not_a_dir.display().to_string());
        assert!(!event.str("error").is_empty());
    }

    #[test]
    fn a_store_that_cannot_create_its_directory_refuses_every_write() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("units"), b"a file").unwrap();
        let store = RecordStore::open(root.path());
        let err = store.write(&record(UnitRecordState::Running)).unwrap_err();
        assert!(err.to_string().contains("unavailable"), "{err}");
        assert!(store.owned_records().is_err());
    }
}
