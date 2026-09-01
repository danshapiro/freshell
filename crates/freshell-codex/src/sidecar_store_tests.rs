//! Unit tests for the durable codex sidecar record store ([`super`]).
//!
//! Tempfile tempdirs ONLY — no global state, nothing outside each test's own
//! temp dir. In particular these tests must NEVER touch
//! `~/.freshell/codex-sidecars/` (Node's store), the production
//! `~/.freshell/rust-codex-sidecars/` root (wired in Task 10), or any live
//! process the test did not itself spawn.
//!
//! PROCESS SAFETY (identity tests): each identity test spawns and reaps ONLY
//! its own child (`sleep 300`), killed in a [`ChildGuard`] drop guard —
//! nothing else on the machine is ever signalled.

use super::*;

fn sample_record(ownership_id: &str) -> CodexSidecarRecord {
    CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: ownership_id.to_string(),
        pid: 4242,
        starttime: 123_456_789,
        cmdline: vec![
            "codex".to_string(),
            "-c".to_string(),
            "features.apps=false".to_string(),
            "app-server".to_string(),
            "--listen".to_string(),
            "ws://127.0.0.1:7777".to_string(),
        ],
        ws_url: "ws://127.0.0.1:7777".to_string(),
        session_id: Some("019810de-1e5f-7db3-9c47-1c2a3b4c5d6e".to_string()),
        terminal_id: None,
        server_instance_id: "srv-1".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
    }
}

fn dir_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("read_dir root")
        .map(|e| {
            e.expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn record_roundtrips_through_disk() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let active = sample_record("codex-sidecar-11111111-1111-4111-8111-111111111111");
    // A second record pins the Retained tagged-enum shape and the
    // Option-field round-trip (session_id absent, terminal_id present).
    let retained = CodexSidecarRecord {
        ownership_id: "codex-sidecar-22222222-2222-4222-8222-222222222222".to_string(),
        session_id: None,
        terminal_id: Some("term-9".to_string()),
        state: SidecarRecordState::Retained {
            reason: "server_death_with_live_sidecar".to_string(),
        },
        ..sample_record("")
    };
    store.write(&active).expect("write active");
    store.write(&retained).expect("write retained");

    let mut loaded = store.load_all();
    loaded.sort_by(|a, b| a.ownership_id.cmp(&b.ownership_id));
    assert_eq!(loaded, vec![active, retained]);
}

#[test]
fn write_is_atomic_sibling_tmp_then_rename() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let record = sample_record("codex-sidecar-33333333-3333-4333-8333-333333333333");
    store.write(&record).expect("write");

    // No *.tmp-* residue after a successful write (sibling tmp was renamed
    // into place, tabs_persist.rs:682-708 discipline).
    let names = dir_names(dir.path());
    assert!(
        names.iter().all(|n| !n.contains(".tmp-")),
        "no tmp residue may remain: {names:?}"
    );

    // The destination is `<root>/<ownership_id>.json` and parses back.
    let dest = dir.path().join(format!("{}.json", record.ownership_id));
    let bytes = std::fs::read(&dest).expect("destination file exists");
    let parsed: CodexSidecarRecord =
        serde_json::from_slice(&bytes).expect("destination parses as a record");
    assert_eq!(parsed, record);
}

#[test]
fn disabled_store_is_a_silent_noop() {
    let store = CodexSidecarStore::disabled();
    assert!(!store.is_enabled());
    let record = sample_record("codex-sidecar-44444444-4444-4444-8444-444444444444");
    store.write(&record).expect("disabled write is Ok(())");
    store
        .remove(&record.ownership_id)
        .expect("disabled remove is Ok(())");
    assert!(store.load_all().is_empty());
}

#[test]
fn corrupt_record_is_quarantined_not_fatal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let healthy = sample_record("codex-sidecar-55555555-5555-4555-8555-555555555555");
    store.write(&healthy).expect("write healthy");
    // Hand-written garbage beside it (fail-loud-per-row policy,
    // pane_ledger.rs module header).
    let garbage = dir.path().join("codex-sidecar-garbage.json");
    std::fs::write(&garbage, b"{ this is not json").expect("write garbage");

    let loaded = store.load_all();
    assert_eq!(loaded, vec![healthy], "the healthy row survives");

    assert!(!garbage.exists(), "the garbage row must be renamed aside");
    let names = dir_names(dir.path());
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("codex-sidecar-garbage.json.quarantined-")),
        "quarantine residue must exist: {names:?}"
    );
}

#[cfg(unix)] // flock is the unix-only single-writer primitive (pane_ledger parity)
#[test]
fn second_locked_open_comes_up_disabled() {
    // Single-writer flock (pane_ledger.rs:236-274): never two writers on one
    // store. flock state rides the open file description, so a second open
    // in the SAME process still contends — no child process needed.
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    let holder = CodexSidecarStore::new_locked(Some(root.clone()));
    assert!(holder.is_enabled(), "first locked open owns the store");
    let record = sample_record("codex-sidecar-66666666-6666-4666-8666-666666666666");
    holder.write(&record).expect("holder write");

    let loser = CodexSidecarStore::new_locked(Some(root.clone()));
    assert!(!loser.is_enabled(), "second locked open must be DISABLED");
    let loser_record = sample_record("codex-sidecar-77777777-7777-4777-8777-777777777777");
    loser
        .write(&loser_record)
        .expect("disabled write is an Ok(()) no-op");
    assert!(loser.load_all().is_empty(), "disabled loser reads nothing");
    assert!(
        !root
            .join(format!("{}.json", loser_record.ownership_id))
            .exists(),
        "the disabled loser's no-op write left no file behind"
    );
    drop(holder);
}

// ---------------------------------------------------------------------------
// Pid identity evidence + verification (Task 2). /proc semantics are
// Linux-only, so these tests are #[cfg(target_os = "linux")]; the non-Linux
// stubs (None / Unverifiable) are covered by the type system, not spawned
// processes.
// ---------------------------------------------------------------------------

/// Kills and reaps ONLY the guarded child on drop (defer-style guard) — the
/// test's own `sleep 300`, nothing else on the machine. `kill` on an
/// already-reaped `Child` is a no-op error inside std (no signal is sent to
/// a possibly-recycled pid), so double-cleanup is safe.
#[cfg(target_os = "linux")]
struct ChildGuard(std::process::Child);

#[cfg(target_os = "linux")]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(target_os = "linux")]
fn spawn_own_sleep_child() -> ChildGuard {
    ChildGuard(
        std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn this test's own sleep child"),
    )
}

/// A record carrying the spawned child's REAL `/proc` evidence.
///
/// Race note: between fork() and exec(), `/proc/<pid>/cmdline` transiently
/// holds the PARENT's argv (possibly a truncated prefix) — reading in that
/// window captures wrong bytes and the verify re-read a millisecond later
/// diverges (observed as a load-only `Mismatch` flake in `cargo test
/// --workspace`). Poll until cmdline demonstrably reflects the exec'ed child.
#[cfg(target_os = "linux")]
fn record_for_child(pid: u32) -> CodexSidecarRecord {
    let cmdline = {
        let mut attempts = 0;
        loop {
            if let Some(args) = proc_cmdline(pid as i32) {
                if args == ["sleep", "300"] {
                    break args;
                }
            }
            attempts += 1;
            assert!(
                attempts <= 1000,
                "child cmdline never reflected exec within 1000ms"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    };
    CodexSidecarRecord {
        pid,
        starttime: proc_starttime(pid as i32).expect("live child has a starttime"),
        cmdline,
        ..sample_record("codex-sidecar-88888888-8888-4888-8888-888888888888")
    }
}

#[cfg(target_os = "linux")]
#[test]
fn proc_starttime_identifies_a_live_child_and_none_after_exit() {
    let mut child = spawn_own_sleep_child();
    let pid = child.0.id() as i32;
    assert!(
        proc_starttime(pid).is_some(),
        "a live child must have a readable starttime"
    );
    // Kill + reap OUR OWN child; after the reap the pid is gone from /proc.
    child.0.kill().expect("kill own child");
    child.0.wait().expect("reap own child");
    assert_eq!(proc_starttime(pid), None, "a reaped pid must read as gone");
}

#[cfg(target_os = "linux")]
#[test]
fn verify_identity_confirms_own_spawned_child() {
    let child = spawn_own_sleep_child();
    let record = record_for_child(child.0.id());
    assert_eq!(verify_sidecar_identity(&record), IdentityVerdict::Verified);
}

#[cfg(target_os = "linux")]
#[test]
fn verify_identity_rejects_cmdline_mismatch_without_signalling() {
    let mut child = spawn_own_sleep_child();
    // The live child's pid+starttime but a DIFFERENT cmdline: pid-reuse shape.
    let record = CodexSidecarRecord {
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(child.0.id())
    };
    assert_eq!(verify_sidecar_identity(&record), IdentityVerdict::Mismatch);
    // Verification is read-only: the mismatching child must still be alive
    // (NEVER signalled) afterwards.
    assert_eq!(
        child.0.try_wait().expect("try_wait own child"),
        None,
        "verification must never signal a mismatching pid"
    );
    assert!(
        proc_starttime(child.0.id() as i32).is_some(),
        "the mismatching child is still visible in /proc"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn verify_identity_reports_dead_for_missing_pid() {
    // A reaped child: real evidence captured live, then the pid goes away.
    let mut child = spawn_own_sleep_child();
    let record = record_for_child(child.0.id());
    child.0.kill().expect("kill own child");
    child.0.wait().expect("reap own child");
    assert_eq!(verify_sidecar_identity(&record), IdentityVerdict::Dead);

    // And a pid that cannot exist: far beyond /proc/sys/kernel/pid_max
    // (kernel ceiling PID_MAX_LIMIT = 4_194_304), verified against the
    // machine's actual setting so the "impossible" claim is real evidence.
    let pid_max: u64 = std::fs::read_to_string("/proc/sys/kernel/pid_max")
        .expect("read pid_max")
        .trim()
        .parse()
        .expect("parse pid_max");
    let impossible = CodexSidecarRecord {
        pid: 999_999_999,
        ..sample_record("codex-sidecar-99999999-9999-4999-8999-999999999999")
    };
    assert!(
        u64::from(impossible.pid) > pid_max,
        "test pid {} must exceed this machine's pid_max {pid_max}",
        impossible.pid
    );
    assert_eq!(verify_sidecar_identity(&impossible), IdentityVerdict::Dead);
}
