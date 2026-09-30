//! WSL-outage RCA §6.4 acceptance: SIGHUP (what a dying terminal/session
//! host sends) triggers a GRACEFUL shutdown — previously it killed the
//! process with no log at all — and the shutdown emits one attributable
//! forensics line. Black-box against the real binary (freshell-server is
//! [[bin]]-only), the safe11_term22_shutdown_reaping.rs harness convention.
#![cfg(unix)]

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef-sighup-forensics";

// discover_server_binary()/find_sibling copied from
// tests/safe11_term22_shutdown_reaping.rs:37-53 (FRESHELL_SERVER_BIN env
// override -> sibling of the test binary -> `cargo build --bin
// freshell-server` fallback).
fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

fn find_sibling(suffix: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = dir.join(format!("freshell-server{suffix}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn allocate_ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn wait_for_health(port: u16, child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let url = format!("http://127.0.0.1:{port}/api/health");
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false; // exited early -- never healthy
        }
        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn drain_stderr(child: &mut Child) -> String {
    let mut buf = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let _ = stderr.read_to_string(&mut buf);
    }
    buf
}

/// Poll `child.try_wait()` until it exits or `timeout` elapses; panics (after
/// killing + reaping the child) on timeout so the failure is attributable
/// rather than a leaked process.
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
    let stderr = drain_stderr(child);
    panic!("server did not exit within {timeout:?} of SIGHUP; stderr:\n{stderr}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sighup_triggers_graceful_shutdown_and_logs_forensics() {
    let binary = discover_server_binary();
    let home = tempfile::tempdir().expect("tempdir home");
    // Boot exactly as safe11_term22_shutdown_reaping.rs does: same env vars
    // (isolated home, ephemeral PORT, AUTH_TOKEN), same /api/health poll.
    let port = allocate_ephemeral_port();
    let mut child = Command::new(&binary)
        .env("PORT", port.to_string())
        .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server");
    let healthy = wait_for_health(port, &mut child, Duration::from_secs(15)).await;
    if !healthy {
        // Kill (and reap) BEFORE draining stderr: if the server is still
        // alive, `read_to_string` blocks until its stderr pipe EOFs, which
        // only happens once the process actually exits.
        let _ = child.kill();
        let _ = child.wait();
        let stderr = drain_stderr(&mut child);
        panic!("server never became healthy; stderr:\n{stderr}");
    }
    let pid = child.id() as i32;

    // SIGHUP the server (a process this test spawned itself).
    unsafe {
        assert_eq!(libc::kill(pid, libc::SIGHUP), 0, "kill(SIGHUP) failed");
    }

    // Graceful exit with status 0 within the 5s hard-timeout window.
    let status = wait_with_timeout(&mut child, std::time::Duration::from_secs(5));
    assert!(
        status.success(),
        "SIGHUP must produce a graceful 0 exit, got {status:?}"
    );

    // One forensics line landed in the JSONL server log before teardown.
    let log_path = home
        .path()
        .join(".freshell")
        .join("logs")
        .join("rust-server.jsonl");
    let log = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", log_path.display()));
    let forensics_line = log
        .lines()
        .find(|l| l.contains("shutdown_forensics"))
        .expect("a shutdown_forensics line must be logged on SIGHUP");
    assert!(
        forensics_line.contains("SIGHUP"),
        "line must name the signal: {forensics_line}"
    );
    assert!(
        forensics_line.contains("parent_chain"),
        "line must carry the parent chain: {forensics_line}"
    );
    assert!(
        forensics_line.contains("boot_parent_chain"),
        "line must carry the boot-time chain for comparison: {forensics_line}"
    );
}
