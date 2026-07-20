//! DIAG-02 outer operator-experience test: proves `POST /api/logs/client`
//! actually EMITS every validated entry into the structured JSONL log
//! (`rust-server.jsonl`), instead of silently discarding it after validation.
//!
//! Confirmed production bug this guards against: `boot.rs::logs_client`
//! validated the request body via `client_logs_issues` and returned `204`
//! WITHOUT ever emitting the entries anywhere -- during a real incident the
//! browser's own error reports vanished, blinding the investigation. Legacy
//! parity (`server/client-logs.ts:33-53`): every entry is re-emitted via the
//! pino logger AT THE ENTRY'S OWN SEVERITY (`log[level](...)`), with
//! `message = entry.message || entry.event || 'Client log'`.
//!
//! Black-box (spawns the compiled binary) for the same reason
//! `diag01_diag03_logging.rs` is: `freshell-server` is a `[[bin]]`-only crate
//! with no `[lib]` target, so there is no in-process API surface to attach an
//! in-process `tracing` capture layer to -- the only way to observe what the
//! REAL server process logs is to read the JSONL file it writes, exactly as
//! an operator would.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Duplicated (deliberately -- see `diag01_diag03_logging.rs` for the near-twin
/// original; each integration test file is its own binary, so there is no
/// shared-module target to import small helpers like these from without
/// growing the crate's public surface just for tests) binary/port/health
/// helpers.
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
            return false;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_log_entries_are_emitted_into_the_structured_log() {
    let server_binary = discover_server_binary();

    let home = tempfile::tempdir().expect("create temp home");
    let home_path = home.path().to_path_buf();

    let port = allocate_ephemeral_port();
    let token = format!(
        "diag02-client-log-emission-secret-{}",
        uuid::Uuid::new_v4()
    );

    let mut child = Command::new(&server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", &token)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env("HOME", &home_path)
        .env("FRESHELL_HOME", &home_path)
        // `debug`, not the default `info` threshold `logging::init` falls back
        // to absent `RUST_LOG`: this test asserts a `debug`-severity client
        // entry lands too, and `tracing::debug!` events are filtered out
        // below `info` by the standard `EnvFilter` -- exactly like any other
        // backend `debug!` call, by design (DIAG-01's level-control
        // convention applies uniformly, not specially loosened for client
        // logs). Setting it explicitly here tests the severity-mapping
        // logic itself, independent of that orthogonal, already-correct
        // default-level policy.
        .env("RUST_LOG", "debug")
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

    // A unique marker per test run so these assertions can never coincidentally
    // match an unrelated log line (e.g. from a previous rotated backup).
    let marker = format!("diag02-marker-{}", uuid::Uuid::new_v4());

    let body = serde_json::json!({
        "client": { "id": "test-client-1", "url": "http://example.test/app" },
        "entries": [
            {
                "timestamp": "2026-01-01T00:00:00.000Z",
                "severity": "error",
                "message": format!("{marker} error entry"),
                "event": "test.error.event",
            },
            {
                "timestamp": "2026-01-01T00:00:01.000Z",
                "severity": "warn",
                "message": format!("{marker} warn entry"),
            },
            {
                "timestamp": "2026-01-01T00:00:02.000Z",
                "severity": "info",
                "message": format!("{marker} info entry"),
            },
            {
                "timestamp": "2026-01-01T00:00:03.000Z",
                "severity": "debug",
                "message": format!("{marker} debug entry"),
            },
        ],
    });

    // This crate's `reqwest` dependency is declared with `default-features =
    // false` and no `json` feature (only `stream`/`rustls`, needed by
    // `updater.rs`) -- so build the JSON body by hand rather than pulling in
    // an extra feature just for this one test file.
    let resp = client
        .post(format!("{base}/api/logs/client"))
        .header("x-auth-token", &token)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).expect("serialize request body"))
        .send()
        .await
        .expect("POST /api/logs/client");
    assert_eq!(
        resp.status().as_u16(),
        204,
        "expected the client-log sink to accept a valid batch with 204"
    );

    // Give the (synchronous, flush-on-write) logger a brief moment to settle.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let _ = child.kill();
    let _ = child.wait();

    let log_path = home_path
        .join(".freshell")
        .join("logs")
        .join("rust-server.jsonl");
    assert!(
        log_path.exists(),
        "expected a structured log file at {}",
        log_path.display()
    );
    let content = std::fs::read_to_string(&log_path).expect("read log file");
    let mut parsed: Vec<serde_json::Value> = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("invalid JSON line: {e}\n{line}"));
        parsed.push(value);
    }

    // For each severity, expect exactly one log entry: target ==
    // `freshell_server::client_logs`, level uppercased matching the entry's
    // own severity (never coerced to a single fixed level), and `msg`
    // containing the marker + this entry's distinguishing suffix.
    for (severity, level, suffix) in [
        ("error", "ERROR", "error entry"),
        ("warn", "WARN", "warn entry"),
        ("info", "INFO", "info entry"),
        ("debug", "DEBUG", "debug entry"),
    ] {
        let expected_msg = format!("{marker} {suffix}");
        let found = parsed.iter().any(|v| {
            let target_ok = v.get("target").and_then(|t| t.as_str()) == Some("freshell_server::client_logs");
            let level_ok = v.get("level").and_then(|l| l.as_str()) == Some(level);
            let msg_ok = v
                .get("msg")
                .and_then(|m| m.as_str())
                .map(|m| m.contains(&expected_msg))
                .unwrap_or(false);
            target_ok && level_ok && msg_ok
        });
        assert!(
            found,
            "expected a '{severity}'-severity client-log entry (msg containing {expected_msg:?}) \
             at target 'freshell_server::client_logs' with level {level}, but none was found in \
             the structured log -- entries: {parsed:#?}"
        );
    }
}
