//! Durable codex **sidecar record store** — one JSON file per owned
//! `codex app-server` sidecar, so a restarted server can reattach to (or
//! conservatively reap) processes a previous generation spawned (kata
//! ynfn/da92 groundwork; the reconciler lands in later tasks). Identity
//! verification against a record's `/proc` evidence lives below
//! ([`verify_sidecar_identity`]).
//!
//! Production root (wired in Task 10): `<home>/.freshell/rust-codex-sidecars/`.
//! The `rust-` prefix is the anti-collision convention with Node's
//! `~/.freshell/codex-sidecars/` store (precedent: `rust-session-cache.json`)
//! — the two servers must never share a writer on one directory.
//!
//! Layout: `<root>/<ownership_id>.json` (ownership ids are
//! `codex-sidecar-<uuid-v4>`, filesystem-safe as-is — `durability.rs:36`),
//! `<root>/lock` (single-writer flock), corrupt rows renamed aside to
//! `<name>.quarantined-<millis>`.
//!
//! Policies, all inherited from `freshell_ws::pane_ledger` (the store this is
//! modelled on):
//! - **Single writer:** [`CodexSidecarStore::new_locked`] holds an exclusive
//!   advisory `flock(2)` on `<root>/lock` for the process lifetime; on
//!   contention the store comes up DISABLED (every write an `Ok(())` no-op) —
//!   never two writers on one store (`pane_ledger.rs:236-274`).
//! - **Atomic, durable writes:** sibling tmp → write → `sync_all` → rename →
//!   fsync parent dir (`tabs_persist.rs:682-708`).
//! - **Corruption:** fail loud PER-ROW — quarantine (rename aside + ERROR
//!   log), never silently drop, never fail the whole store (`pane_ledger.rs`
//!   module header).

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Schema version stamped into every record. Rows with a different version
/// are quarantined loudly at load, never silently reinterpreted (the
/// `LEDGER_VERSION` policy, `pane_ledger.rs:57`).
pub const SIDECAR_RECORD_VERSION: u32 = 1;

/// One durable sidecar record — everything a restarted server needs to
/// re-verify (pid + starttime + cmdline), reattach to (ws_url), or attribute
/// (ownership/session/terminal ids) a codex app-server it spawned.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSidecarRecord {
    pub record_version: u32,
    /// `"codex-sidecar-<uuid>"` (`durability.rs:36`) — also the file name stem.
    pub ownership_id: String,
    pub pid: u32,
    /// `/proc/<pid>/stat` field 22 — the pid-reuse guard: `(pid, starttime)`
    /// uniquely identifies a process incarnation.
    pub starttime: u64,
    /// `/proc/<pid>/cmdline` argv, NUL-split.
    pub cmdline: Vec<String>,
    /// The app-server's `--listen` URL.
    pub ws_url: String,
    /// Codex thread id, enriched when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Enriched at adopt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// `durability.rs::default_server_instance_id()`.
    pub server_instance_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub state: SidecarRecordState,
    /// Spawning lane. Absent (`None`) on all pre-existing rows; `None` means
    /// terminal-pane for claim purposes and must keep meaning that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<SidecarLane>,
}

/// Lifecycle state of a recorded sidecar: `Active` (owned by a live server
/// generation) or `Retained { reason }` (deliberately left running across a
/// server death, awaiting reconciliation).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SidecarRecordState {
    Active,
    Retained { reason: String },
}

/// Which spawning lane owns a recorded sidecar. `None` decodes every row
/// written before this field existed — all of them terminal-pane writes —
/// and the claim path must treat `None`/`TerminalPane` identically forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SidecarLane {
    /// `SpawnedCodexAppServerRuntime` (terminal-pane codex sessions).
    TerminalPane,
    /// `FreshCodexState::spawn_sidecar` (freshcodex fresh-agent panes).
    FreshAgent,
}

/// The durable record store. `root: None` ⇒ DISABLED: every write/remove is
/// an `Ok(())` no-op and `load_all` is empty (the PaneLedger
/// disabled-fallback shape, `pane_ledger.rs:200-212`).
pub struct CodexSidecarStore {
    root: Option<PathBuf>,
    /// Held for the process lifetime by `new_locked` (single-writer guard);
    /// the kernel releases the flock on process death.
    #[allow(dead_code)] // read only by the kernel (flock lifetime)
    lock_file: Option<std::fs::File>,
}

impl CodexSidecarStore {
    /// Production construction: exclusive advisory `flock(2)` on
    /// `<root>/lock`; on contention log a loud structured ERROR and come up
    /// DISABLED (`pane_ledger.rs:236-274` pattern).
    pub fn new_locked(root: Option<PathBuf>) -> Self {
        let Some(r) = root else {
            return Self::disabled();
        };
        match Self::acquire_store_lock(&r) {
            Ok(lock_file) => Self {
                root: Some(r),
                lock_file,
            },
            Err(err) => {
                tracing::error!(
                    target: "freshell_codex::sidecar_store",
                    root = %r.display(),
                    error = %err,
                    "sidecar_store_lock_unavailable: another writer holds <root>/lock; \
                     store DISABLED for this process (never two writers on one store)"
                );
                Self::disabled()
            }
        }
    }

    #[cfg(unix)]
    fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>> {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(root)?;
        // Content irrelevant (only existence + flock state matter);
        // truncate(false) avoids clippy's suspicious_open_options.
        //
        // O_CLOEXEC: `std::fs::File` opens close-on-exec by DEFAULT — KEEP it
        // that way (no custom_flags stripping it). flock state rides the open
        // file description, so a leaked lock fd inherited by a detached,
        // retained sidecar (Task 3 removes kill_on_drop) would keep holding
        // the flock after the server dies and silently disable the store for
        // every future server generation (reports/V6.md NA-3).
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(root.join("lock"))?;
        // SAFETY: `fd` is a valid open descriptor owned by `file` for the
        // duration of the call; flock only mutates kernel lock state.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            Ok(Some(file))
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(not(unix))]
    fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>> {
        // No advisory-lock primitive on this platform — construct normally
        // (PaneLedger / ConfigLock non-unix parity).
        std::fs::create_dir_all(root)?;
        Ok(None)
    }

    /// Lock-free construction — tests and verification handles over a live
    /// server's dir must not fight the server's flock (`pane_ledger.rs:214-229`).
    /// Production uses [`CodexSidecarStore::new_locked`].
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Some(root),
            lock_file: None,
        }
    }

    /// A store that stores nothing.
    pub fn disabled() -> Self {
        Self {
            root: None,
            lock_file: None,
        }
    }

    /// Whether this store actually stores anything (`root: Some`).
    pub fn is_enabled(&self) -> bool {
        self.root.is_some()
    }

    /// Write (create or replace) one record atomically, fsync'd: sibling tmp
    /// (PID+millis unique) + write + `sync_all` + rename + fsync parent dir
    /// (the `write_row_atomic` idiom, `pane_ledger.rs:983-1000`).
    pub fn write(&self, record: &CodexSidecarRecord) -> std::io::Result<()> {
        let Some(root) = self.root.as_ref() else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(record)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let dest = record_path(root, &record.ownership_id);
        let tmp = root.join(format!(
            "{}.json.tmp-{}-{}",
            record.ownership_id,
            std::process::id(),
            now_millis()
        ));
        atomic_write_durable(&dest, &tmp, &bytes)
    }

    /// Remove one record; idempotent (a missing row is `Ok(())`).
    pub fn remove(&self, ownership_id: &str) -> std::io::Result<()> {
        let Some(root) = self.root.as_ref() else {
            return Ok(());
        };
        match std::fs::remove_file(record_path(root, ownership_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Load every healthy record. Corrupt rows are quarantined loudly —
    /// renamed aside to `<name>.quarantined-<millis>` + ERROR log — never
    /// silently dropped, and never fail the healthy rows (the
    /// fail-loud-PER-ROW policy, `pane_ledger.rs` module header).
    pub fn load_all(&self) -> Vec<CodexSidecarRecord> {
        let Some(root) = self.root.as_ref() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(root) else {
            return Vec::new(); // no root dir yet ⇒ nothing recorded
        };
        let mut records = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue; // `lock`, *.tmp-* and *.quarantined-* residue
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    tracing::error!(
                        target: "freshell_codex::sidecar_store",
                        path = %path.display(),
                        error = %e,
                        "sidecar_record_unreadable: row skipped (io error, not corruption)"
                    );
                    continue;
                }
            };
            match serde_json::from_slice::<CodexSidecarRecord>(&bytes) {
                Ok(record) if record.record_version == SIDECAR_RECORD_VERSION => {
                    records.push(record);
                }
                Ok(record) => quarantine_row(
                    &path,
                    &format!("unsupported recordVersion {}", record.record_version),
                ),
                Err(e) => quarantine_row(&path, &format!("parse: {e}")),
            }
        }
        records
    }
}

// ---------------------------------------------------------------------------
// Pid identity evidence + verification. A durable record is only ever
// TRUSTED after its `(pid, starttime, cmdline)` evidence is re-verified
// against live `/proc` — only [`IdentityVerdict::Verified`] may ever be
// signalled. Environ tags are deliberately NOT required here: YAMA can hide
// `/proc/<pid>/environ` for reparented orphans, while `stat` and `cmdline`
// are world-readable.
// ---------------------------------------------------------------------------

/// /proc/<pid>/stat field 22; None for gone/zombie. (pid, starttime) is the
/// pid-reuse guard. Deliberate duplicate of the private
/// freshell-freshagent/src/session_lease.rs:144-160 helper (dependency
/// direction forbids importing it) — keep the parsing identical: split at the
/// LAST ')' then index 19, rejecting Z/X states.
#[cfg(target_os = "linux")]
pub fn proc_starttime(pid: i32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm (field 2) may contain spaces/parens: split at the LAST ')' — the
    // remainder starts at field 3 (state), so starttime (field 22) is index
    // 19 there (session_lease.rs:144-160 parsing, kept identical).
    let rest = stat.rsplit(')').next()?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    match fields.first() {
        Some(&"Z") | Some(&"X") | None => return None,
        Some(_) => {}
    }
    fields.get(19)?.parse().ok()
}

/// Non-Linux stub: no `/proc`, no evidence — `None` (never verified ⇒ never
/// killed).
#[cfg(not(target_os = "linux"))]
pub fn proc_starttime(_pid: i32) -> Option<u64> {
    None
}

/// /proc/<pid>/cmdline, NUL-split into argv. World-readable (no ptrace/YAMA
/// constraint, unlike /proc/<pid>/environ).
#[cfg(target_os = "linux")]
pub fn proc_cmdline(pid: i32) -> Option<Vec<String>> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        bytes
            .split(|b| *b == 0)
            .filter(|arg| !arg.is_empty())
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect(),
    )
}

/// Non-Linux stub: no `/proc`, no evidence — `None` (never verified ⇒ never
/// killed).
#[cfg(not(target_os = "linux"))]
pub fn proc_cmdline(_pid: i32) -> Option<Vec<String>> {
    None
}

/// The answer to "is `/proc/<pid>` still the process this record describes?"
/// — the gate every reattach/reap decision goes through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityVerdict {
    /// (pid, starttime, cmdline) all match the record — this IS our sidecar.
    Verified,
    /// pid gone or zombie — the sidecar is dead; the record is stale.
    Dead,
    /// pid alive but starttime or cmdline differ — pid reuse; NEVER signal.
    Mismatch,
    /// non-Linux / evidence unreadable — NEVER signal.
    Unverifiable,
}

/// Re-verify a record's `(pid, starttime, cmdline)` evidence against live
/// `/proc`. Read-only — never signals anything. A pid that vanishes between
/// the two reads yields [`IdentityVerdict::Unverifiable`] (conservative:
/// never signalled), not a guess.
#[cfg(target_os = "linux")]
pub fn verify_sidecar_identity(record: &CodexSidecarRecord) -> IdentityVerdict {
    // pid > i32::MAX cannot exist on Linux (PID_MAX_LIMIT = 2^22); the `as`
    // wrap would produce a negative pid whose /proc entry never exists, so
    // the verdict is still the safe `Dead`.
    let pid = record.pid as i32;
    let Some(starttime) = proc_starttime(pid) else {
        return IdentityVerdict::Dead;
    };
    if starttime != record.starttime {
        return IdentityVerdict::Mismatch;
    }
    let Some(cmdline) = proc_cmdline(pid) else {
        return IdentityVerdict::Unverifiable;
    };
    if cmdline != record.cmdline {
        return IdentityVerdict::Mismatch;
    }
    IdentityVerdict::Verified
}

/// Non-Linux stub: no `/proc` evidence — [`IdentityVerdict::Unverifiable`]
/// (never verified ⇒ never killed).
#[cfg(not(target_os = "linux"))]
pub fn verify_sidecar_identity(_record: &CodexSidecarRecord) -> IdentityVerdict {
    IdentityVerdict::Unverifiable
}

// ---------------------------------------------------------------------------
// Process-global store handle (Task 3 seam; wired at server boot in Task 10).
// A re-settable RwLock rather than the manager's OnceLock: tests inject a
// per-instance store (`SpawnedCodexAppServerRuntime::with_command_and_store`)
// and never touch this global, so no set-once ratchet is needed here.
// ---------------------------------------------------------------------------

static GLOBAL_SIDECAR_STORE: RwLock<Option<Arc<CodexSidecarStore>>> = RwLock::new(None);

/// Install the process-wide sidecar store (server boot, before any codex
/// terminal can spawn). Later calls replace the handle.
pub fn set_codex_sidecar_store(store: Arc<CodexSidecarStore>) {
    *GLOBAL_SIDECAR_STORE.write().unwrap() = Some(store);
}

/// The installed process-wide store, if any. `None` (nothing installed) means
/// callers fall back to [`CodexSidecarStore::disabled`] — behavior identical
/// to the pre-store world. Also read by the freshagent lane
/// (freshell-freshagent), which writes `Some(SidecarLane::FreshAgent)`
/// records at spawn.
pub fn codex_sidecar_store() -> Option<Arc<CodexSidecarStore>> {
    GLOBAL_SIDECAR_STORE.read().unwrap().clone()
}

fn record_path(root: &Path, ownership_id: &str) -> PathBuf {
    root.join(format!("{ownership_id}.json"))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Rename a corrupt row aside to `<name>.quarantined-<millis>` and log a
/// loud structured ERROR — the row is preserved for forensics, never
/// silently deleted (`pane_ledger.rs` quarantine policy).
fn quarantine_row(path: &Path, why: &str) {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("record");
    let quarantined = path.with_file_name(format!("{file_name}.quarantined-{}", now_millis()));
    match std::fs::rename(path, &quarantined) {
        Ok(()) => tracing::error!(
            target: "freshell_codex::sidecar_store",
            path = %path.display(),
            quarantined = %quarantined.display(),
            why,
            "sidecar_record_quarantined: corrupt row renamed aside (fail loud per-row)"
        ),
        Err(e) => tracing::error!(
            target: "freshell_codex::sidecar_store",
            path = %path.display(),
            why,
            error = %e,
            "sidecar_record_quarantine_failed: corrupt row could not be renamed aside"
        ),
    }
}

/// Durably replace `destination` with `bytes`: write + `sync_all` the
/// temporary file, rename it atomically, then `sync_all` the parent directory
/// so the new name survives a power/kernel failure.
///
/// PROVENANCE: a deliberate, verbatim duplicate of
/// `freshell_ws::tabs_persist::atomic_write_durable` (`tabs_persist.rs:682-708`).
/// It cannot be imported: `freshell-ws` depends on `freshell-codex`, so the
/// dependency direction is forbidden — the same reason the repo already
/// duplicates `CODEX_MANAGED_REMOTE_CONFIG_ARGS` (`launch_plan.rs:33` vs
/// `cli_launch.rs:177`). Keep the two bodies in sync.
fn atomic_write_durable(destination: &Path, temporary: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("destination has no parent: {}", destination.display()),
        )
    })?;
    if temporary.parent() != Some(parent) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "atomic-write temporary file must be a sibling of the destination",
        ));
    }
    std::fs::create_dir_all(parent)?;
    let mut file = std::fs::File::create(temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temporary, destination)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
#[path = "sidecar_store_tests.rs"]
mod tests;
