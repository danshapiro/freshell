//! DIAG-01 + DIAG-03 outer operator-experience test (outcome-oriented,
//! outer-loop-first per the delegation brief): boots the REAL
//! `freshell-server` binary against an isolated temp home + an ephemeral
//! loopback port, drives the requests a real operator would make while
//! debugging ("why did the 404 happen? did the auth token leak anywhere? did
//! the log grow forever?"), then reads the on-disk JSONL log and asserts it
//! actually answers those questions -- not merely that some `tracing` macro
//! fires somewhere in the source.
//!
//! Scope: DIAG-01 (structured JSONL with per-request correlation) + DIAG-03
//! (redaction from the first byte + bounded size-based rotation). See
//! `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` for the
//! full acceptance text and `crates/freshell-server/src/logging.rs`'s module
//! doc comment for exactly which clauses this deliberately-shrunk slice
//! covers vs. defers.
//!
//! This is a black-box test (spawns the compiled binary as a subprocess)
//! because `freshell-server` is a `[[bin]]`-only crate with no `[lib]`
//! target -- there is no in-process API surface for an integration test to
//! import, so proving the operator experience means driving the real thing
//! over HTTP exactly as an operator would.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Locate the compiled `freshell-server` binary. Prefers an explicit
/// `FRESHELL_SERVER_BIN` override, then a sibling of this test binary
/// (the normal `cargo test -p freshell-server` byproduct), and finally
/// falls back to an explicit `cargo build --bin freshell-server` so this
/// test is self-sufficient rather than depending on build ordering.
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

/// Bind-then-drop an ephemeral loopback port. A throwaway server for THIS
/// test only -- never one of the reserved/shared ports.
fn allocate_ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

/// Poll `GET /api/health` until it answers, the child exits early, or the
/// timeout elapses.
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

/// Drain and return child stderr (for diagnostics on an unexpected failure).
fn drain_stderr(child: &mut Child) -> String {
    let mut buf = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let _ = stderr.read_to_string(&mut buf);
    }
    buf
}

/// All log file paths this test cares about: the active file plus any
/// rotated backups (`.1`, `.2`, ... up to a generous scan ceiling so the
/// test itself never hard-codes the production default).
fn all_log_paths(log_path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![log_path.to_path_buf()];
    for n in 1..=10u32 {
        let mut s = log_path.as_os_str().to_os_string();
        s.push(format!(".{n}"));
        let candidate = PathBuf::from(s);
        if candidate.exists() {
            paths.push(candidate);
        }
    }
    paths
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diag01_diag03_operator_experience() {
    let server_binary = discover_server_binary();

    let home = tempfile::tempdir().expect("create temp home");
    let home_path = home.path().to_path_buf();

    let port = allocate_ephemeral_port();
    // A real, uniquely-generated secret -- long enough to pass AUTH_TOKEN
    // validation (>=16 chars, not a default/weak value) and distinctive
    // enough that finding it (or NOT finding it) in the log file is an
    // unambiguous signal, not a coincidental substring match.
    let token = format!("diag01-diag03-outer-test-secret-{}", uuid::Uuid::new_v4());

    let mut child = Command::new(&server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", &token)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env("HOME", &home_path)
        .env("FRESHELL_HOME", &home_path)
        // Deliberately tiny so a modest request loop forces multiple
        // rotations within the test's runtime -- proves the bound is real,
        // not merely configured.
        .env("FRESHELL_LOG_MAX_BYTES", "2000")
        .env("FRESHELL_LOG_MAX_BACKUPS", "2")
        .env_remove("RUST_LOG")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server");

    let healthy = wait_for_health(port, &mut child, Duration::from_secs(20)).await;
    if !healthy {
        let stderr = drain_stderr(&mut child);
        let _ = child.kill();
        let _ = child.wait();
        panic!("freshell-server never became healthy on port {port}; stderr:\n{stderr}");
    }

    let client = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");

    // (a) one OK request -- unauthenticated health check, always 200.
    let ok_resp = client
        .get(format!("{base}/api/health"))
        .send()
        .await
        .expect("GET /api/health");
    assert!(
        ok_resp.status().is_success(),
        "expected /api/health to succeed, got {}",
        ok_resp.status()
    );

    // Pad the log with enough entries to force several rotations under the
    // tiny 2000-byte cap configured above -- proves the bound holds under
    // sustained writes. Deliberately done BEFORE the three
    // semantically-checked requests below: bounded rotation means old
    // entries age out permanently (by design -- see `logging.rs`'s
    // `rotate()`), so the padding must come first, leaving the three
    // requests this test actually inspects as the freshest (never-rotated)
    // entries in the active file.
    for _ in 0..80 {
        let _ = client.get(format!("{base}/api/health")).send().await;
    }

    // (b) one 404 -- an authenticated request to an unmatched /api/* path
    // (a "bad session id" shape), which the fallback answers with a clean
    // JSON 404 (never the SPA shell, never a raw 401 since we ARE
    // authenticated here).
    let bad_session_path = "/api/session-directory/definitely-missing-session-id-xyz";
    let not_found_resp = client
        .get(format!("{base}{bad_session_path}"))
        .header("x-auth-token", &token)
        .send()
        .await
        .expect("GET bad session path");
    assert_eq!(
        not_found_resp.status().as_u16(),
        404,
        "expected the bad-session-id path to 404"
    );

    // (c) one authenticated request carrying the REAL token value in a
    // real header -- exactly the scenario that must never leak it to disk.
    let authed_resp = client
        .get(format!("{base}/api/settings"))
        .header("x-auth-token", &token)
        .send()
        .await
        .expect("GET /api/settings");
    assert!(
        authed_resp.status().is_success(),
        "expected authenticated /api/settings to succeed, got {}",
        authed_resp.status()
    );

    // Give the (synchronous, flush-on-write) logger a brief moment to settle
    // relative to the async response futures above.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let _ = child.kill();
    let _ = child.wait();

    let log_path = home_path
        .join(".freshell")
        .join("logs")
        .join("rust-server.jsonl");
    assert!(
        log_path.exists(),
        "expected a structured log file at {}, but none was created \
         (DIAG-01 structured logging is not wired up yet)",
        log_path.display()
    );

    let log_files = all_log_paths(&log_path);
    let mut combined_raw = String::new();
    let mut all_lines: Vec<String> = Vec::new();
    for path in &log_files {
        let content = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read log file {}: {e}", path.display()));
        combined_raw.push_str(&content);
        for line in content.lines() {
            if !line.trim().is_empty() {
                all_lines.push(line.to_string());
            }
        }
    }

    assert!(
        !all_lines.is_empty(),
        "expected at least one log line across {} file(s)",
        log_files.len()
    );

    // Every non-empty line must be parseable JSON (JSONL contract).
    let mut parsed: Vec<serde_json::Value> = Vec::with_capacity(all_lines.len());
    for (i, line) in all_lines.iter().enumerate() {
        let value: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("log line {i} is not valid JSON: {e}\nline: {line}"));
        parsed.push(value);
    }

    // The 404 must be correlated: some entry has this route + status 404 +
    // a non-empty request id -- "the log answers why".
    let has_correlated_404 = parsed.iter().any(|v| {
        let status_ok = v.get("status").and_then(|s| s.as_u64()) == Some(404);
        let route_ok = v
            .get("route")
            .and_then(|r| r.as_str())
            .map(|r| r.contains("session-directory"))
            .unwrap_or(false);
        let has_request_id = v
            .get("request_id")
            .and_then(|r| r.as_str())
            .map(|r| !r.is_empty())
            .unwrap_or(false);
        status_ok && route_ok && has_request_id
    });
    assert!(
        has_correlated_404,
        "expected a log entry correlating the 404 with its route + a request id; \
         entries: {parsed:#?}"
    );

    // The live secret must never appear anywhere in ANY log byte -- checked
    // against the raw file content (not just parsed values), so no
    // corner (partial line, un-parsed fragment) can hide a leak.
    assert!(
        !combined_raw.contains(&token),
        "the real AUTH_TOKEN value leaked into the log file(s) -- redaction failed"
    );

    // Rotation: with the tiny configured max size and ~80+ requests, the
    // active file must be bounded (not simply appending forever) and at
    // least one rotated backup must exist.
    let active_len = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
    assert!(
        active_len <= 2000 * 2, // generous slack over the configured cap
        "active log file grew to {active_len} bytes, well past the configured \
         2000-byte rotation threshold -- rotation did not bound it"
    );
    let backup_one = {
        let mut s = log_path.as_os_str().to_os_string();
        s.push(".1");
        PathBuf::from(s)
    };
    assert!(
        backup_one.exists(),
        "expected at least one rotated backup file ({}) given ~80+ requests \
         under a 2000-byte cap",
        backup_one.display()
    );
    // Bounded total: never more than active + max_backups(2) = 3 files.
    assert!(
        log_files.len() <= 3,
        "expected at most 3 total log files (active + 2 backups), found {}",
        log_files.len()
    );
}
