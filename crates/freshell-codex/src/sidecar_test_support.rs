//! Shared test helpers for the sidecar lifecycle suites
//! ([`crate::sidecar_reconcile`] + [`crate::sidecar_sweep`] tests) — extracted
//! from `sidecar_reconcile_tests.rs` when Task 9's sweep suite landed in its
//! own file (the pre-authorized 1,000-line split). Compiled only for
//! `cfg(test)` on Linux (the `/proc` evidence helpers), never shipped.
//!
//! PROCESS SAFETY: every helper spawns and signals ONLY the calling test's
//! own children; temp stores only; loopback ephemeral ports only, never
//! 3001/3002.

use std::sync::Arc;
use std::time::Duration;

use crate::sidecar_store::{
    proc_cmdline, proc_starttime, CodexSidecarRecord, CodexSidecarStore, SidecarRecordState,
    SIDECAR_RECORD_VERSION,
};

/// The codex session (thread) id the suites share.
pub(crate) const SESSION: &str = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";

/// Grace window before a "never signalled" assertion: long enough for the
/// fixture's graceful SIGTERM exit to become observable if a signal HAD
/// (wrongly) been sent.
pub(crate) const NEVER_SIGNALLED_GRACE: Duration = Duration::from_millis(300);

/// Kills and reaps ONLY the guarded child on drop (defer-style guard) — the
/// test's own `sleep 300`, nothing else on the machine. `kill` on an
/// already-reaped `Child` is a no-op error inside std (no signal is sent to
/// a possibly-recycled pid), so double-cleanup is safe.
pub(crate) struct ChildGuard(pub(crate) std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawn this test's own `sleep 300` child and wait for exec to complete.
pub(crate) fn spawn_own_sleep_child() -> ChildGuard {
    spawn_own_shell_child("sleep", &["300"], &["sleep", "300"])
}

/// Spawn this test's own child process and poll until `/proc/<pid>/cmdline`
/// reads as `want_cmdline`: immediately after spawn the child may still be
/// post-fork/pre-exec, so evidence captured in that window verifies as a
/// cmdline Mismatch at boot/claim time (observed flake).
pub(crate) fn spawn_own_shell_child(
    program: &str,
    args: &[&str],
    want_cmdline: &[&str],
) -> ChildGuard {
    let guard = ChildGuard(
        std::process::Command::new(program)
            .args(args)
            .spawn()
            .expect("spawn this test's own child"),
    );
    let pid = guard.0.id() as i32;
    let want: Vec<String> = want_cmdline.iter().map(|s| s.to_string()).collect();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while proc_cmdline(pid).as_ref() != Some(&want) {
        assert!(
            std::time::Instant::now() < deadline,
            "test child failed to exec within 5s"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    guard
}

/// A loopback `ws://` URL on an ephemeral port NOTHING listens on (bound,
/// read, dropped) — probe dials fail fast with connection-refused. Never
/// port 3001. For dial-fail records ONLY: the freed port can in principle
/// be re-issued by the kernel to a concurrent listener within the test's
/// window (never observed). Fixture spawns must NOT use this — they use
/// the fixture's port-file protocol ([`FIXTURE_PORT_FILE_ENV`]) instead,
/// which has no free-port window at all.
pub(crate) fn unused_loopback_ws_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    format!("ws://127.0.0.1:{port}")
}

/// Opt-in port-report mode of the fake app-server fixture: when set, the
/// fixture binds a kernel-assigned ephemeral port (`--listen
/// ws://127.0.0.1:0`) and writes the actual port (newline-terminated) to
/// the named file once listening.
pub(crate) const FIXTURE_PORT_FILE_ENV: &str = "FAKE_CODEX_APP_SERVER_PORT_FILE";

/// A record carrying a spawned child's REAL `/proc` evidence.
pub(crate) fn record_for_child(
    ownership_id: &str,
    pid: u32,
    session_id: Option<&str>,
) -> CodexSidecarRecord {
    CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: ownership_id.to_string(),
        pid,
        starttime: proc_starttime(pid as i32).unwrap_or_else(|| {
            panic!(
                "no /proc/{pid}/stat starttime for the fixture child (pid {pid}) — \
                 it was expected to be live; it most likely exited first \
                 (e.g. EADDRINUSE when another fixture won the port)"
            )
        }),
        cmdline: proc_cmdline(pid as i32).unwrap_or_else(|| {
            panic!(
                "no /proc/{pid}/cmdline for the fixture child (pid {pid}) — \
                 it was expected to be live; it most likely exited first"
            )
        }),
        ws_url: unused_loopback_ws_url(),
        session_id: session_id.map(str::to_string),
        terminal_id: None,
        server_instance_id: "srv-prev".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
        lane: None,
    }
}

/// A tempdir-backed store (lock-free test construction).
pub(crate) fn store_in(dir: &tempfile::TempDir) -> Arc<CodexSidecarStore> {
    Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()))
}

/// The committed fake app-server fixture (repo-owned test harness).
pub(crate) fn fake_app_server_fixture() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
}

/// Spawn THIS TEST'S OWN fake app-server on a kernel-assigned loopback
/// ephemeral port and wait for its WS listener to accept. The fixture
/// reports its actual port through the [`FIXTURE_PORT_FILE_ENV`]
/// port-file protocol: there is NO pre-allocated free port for a sibling
/// fixture to steal. (The pre-fix helper allocated a port via bind-drop;
/// the randomized kernel allocator can hand the just-freed port to a
/// concurrent test's fixture, killing ours with EADDRINUSE while our
/// probe handshakes with the thief — the observed once-off
/// "live child has a starttime" flake.)
/// `kill_on_drop(true)` guarantees cleanup kills ONLY this recorded child,
/// even on panic.
pub(crate) async fn spawn_own_fake_app_server(
    ownership_id: &str,
) -> (tokio::process::Child, String) {
    spawn_own_fake_app_server_with_behavior(ownership_id, None).await
}

/// [`spawn_own_fake_app_server`] with a scripted
/// `FAKE_CODEX_APP_SERVER_BEHAVIOR` JSON (e.g. the Task 9 `threadStatuses`
/// knob).
pub(crate) async fn spawn_own_fake_app_server_with_behavior(
    ownership_id: &str,
    behavior_json: Option<&str>,
) -> (tokio::process::Child, String) {
    // The fixture overwrites this file with its actual listening port.
    // NamedTempFile gives a unique path and removes it on drop, even on
    // panic.
    let port_file = tempfile::NamedTempFile::new().expect("create fixture port file");
    let port_file_path = port_file.path().to_owned();
    let mut command = tokio::process::Command::new("node");
    command
        .arg(fake_app_server_fixture())
        .arg("--listen")
        .arg("ws://127.0.0.1:0")
        .env(crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV, ownership_id)
        .env(FIXTURE_PORT_FILE_ENV, &port_file_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(behavior) = behavior_json {
        command.env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior);
    }
    let mut child = command
        .spawn()
        .expect("spawn this test's own fake app-server");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    // Phase 1: the fixture reports the port the kernel assigned IT — the
    // assignment is atomic with the bind, so no other fixture can hold or
    // steal it; the reported URL always belongs to this test's own child.
    let ws_url = loop {
        if let Ok(report) = std::fs::read_to_string(&port_file_path) {
            if let Ok(port) = report.trim().parse::<u16>() {
                break format!("ws://127.0.0.1:{port}");
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("fake app-server exited before reporting its port: {status}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fake app-server never reported its listening port"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    // Phase 2: verify the reported port accepts a WS handshake.
    loop {
        if let Ok(Ok((probe, _response))) = tokio::time::timeout(
            Duration::from_secs(1),
            tokio_tungstenite::connect_async(&ws_url),
        )
        .await
        {
            drop(probe);
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("fake app-server exited before listening: {status}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fake app-server WS never came up"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    (child, ws_url)
}
