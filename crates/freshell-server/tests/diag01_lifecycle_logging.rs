//! DIAG-01 outer acceptance test (black-box, operator-experience): boots the
//! REAL `freshell-server` binary against an isolated temp home + ephemeral
//! loopback port, drives the flows the checklist names (auth, terminal,
//! provider, recoverable error, restart, quit), then parses EVERY line of
//! the on-disk JSONL log and asserts the full required-field schema plus
//! coherent correlation ids.
//!
//! This complements `diag01_diag03_logging.rs` (rotation/redaction under a
//! tiny cap -- deliberately NOT set here, so nothing rotates away) and the
//! in-crate span tests (`freshell-ws/tests/diag01_lifecycle_events.rs`) by
//! proving the assembled binary produces a spec-conformant log end to end.
//!
//! Harness conventions are intentionally duplicated from
//! `safe11_term22_shutdown_reaping.rs` / `diag01_diag03_logging.rs`
//! (this repo's black-box test files each carry their own small copy).

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const AUTH_TOKEN: &str = "diag01-lifecycle-outer-test-secret-9f27c1";

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ── binary + boot harness ────────────────────────────────────────────────

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

/// The committed fake codex app-server fixture (same `CODEX_CMD` mechanism
/// `safe11_term22_shutdown_reaping.rs` uses).
fn fake_codex_app_server_cmd() -> String {
    format!(
        "{}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Seed `<home>/.freshell/config.json` with `freshAgent.enabled: true`
/// before boot (the create gate; an untouched temp home defaults it false).
fn seed_fresh_agent_enabled(home: &std::path::Path) {
    let dir = home.join(".freshell");
    std::fs::create_dir_all(&dir).expect("create .freshell dir");
    std::fs::write(
        dir.join("config.json"),
        serde_json::json!({ "settings": { "freshAgent": { "enabled": true } } }).to_string(),
    )
    .expect("seed config.json");
}

struct Boot {
    child: Child,
    port: u16,
}

async fn boot_server(server_binary: &std::path::Path, home: &std::path::Path) -> Boot {
    let port = allocate_ephemeral_port();
    seed_fresh_agent_enabled(home);
    let mut child = Command::new(server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
        .env("FRESHELL_HOME", home)
        .env("HOME", home)
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
        // The version stamps under test must come from the build constant:
        // an ambient FRESHELL_APP_VERSION on the test host must not leak in
        // and make the assertions compare against the wrong expectation.
        .env_remove("FRESHELL_APP_VERSION")
        .env_remove("RUST_LOG")
        // Same ambient-hygiene class for the log SINK: the assertions below
        // pin the default `<home>/.freshell/logs/rust-server.jsonl` path and
        // expect no rotation, so ambient log-dir/rotation overrides from the
        // test host would otherwise fail the test for the wrong reason.
        .env_remove("FRESHELL_LOG_DIR")
        .env_remove("FRESHELL_LOG_MAX_BYTES")
        .env_remove("FRESHELL_LOG_MAX_BACKUPS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server");
    let healthy = wait_for_health(port, &mut child, Duration::from_secs(20)).await;
    if !healthy {
        let _ = child.kill();
        let _ = child.wait();
        let stderr = drain_stderr(&mut child);
        panic!("freshell-server never became healthy on port {port}; stderr:\n{stderr}");
    }
    Boot { child, port }
}

/// SIGTERM and require exit code 0 within 5s (the graceful-shutdown
/// contract; same shape as safe11's wait).
async fn sigterm_and_reap(boot: &mut Boot) {
    let kill_rc = unsafe { libc::kill(boot.child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(kill_rc, 0, "SIGTERM to the server pid must succeed");
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match boot.child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = boot.child.kill();
                    let _ = boot.child.wait();
                    panic!("server did not exit within 5s of SIGTERM");
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(e) => panic!("try_wait failed: {e}"),
        }
    };
    assert!(
        status.success(),
        "server must exit 0 on SIGTERM (graceful), got {status:?}"
    );
}

// ── ws helpers ───────────────────────────────────────────────────────────

async fn send_json(ws: &mut WsStream, value: &serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("ws send");
}

async fn wait_for_any_message_type(
    ws: &mut WsStream,
    type_names: &[&str],
    timeout: Duration,
) -> Option<(String, serde_json::Value)> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(got_type) = value.get("type").and_then(|t| t.as_str()) {
                        if type_names.contains(&got_type) {
                            return Some((got_type.to_string(), value));
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => return None,
        }
    }
}

// ── log parsing + schema assertions ─────────────────────────────────────

struct LogLine {
    index: usize,
    value: serde_json::Value,
}

fn parse_log(home: &std::path::Path) -> (String, Vec<LogLine>) {
    let log_path = home.join(".freshell/logs/rust-server.jsonl");
    let raw = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", log_path.display()));
    let mut lines = Vec::new();
    for (index, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("log line {index} is not valid JSON: {e}\nline: {line}"));
        lines.push(LogLine { index, value });
    }
    (raw, lines)
}

/// Assert the DIAG-01 per-line required-field schema on one parsed line.
fn assert_line_schema(line: &LogLine, expected_version: &str, expected_pid: u32, raw_line: &str) {
    let v = &line.value;
    let ctx = || {
        format!(
            "line {} ({}): {raw_line}",
            line.index,
            v["msg"].as_str().unwrap_or("?")
        )
    };
    let ts = v["ts"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: missing ts", ctx()));
    assert!(
        chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
        "{}: ts is not RFC3339: {ts}",
        ctx()
    );
    let level = v["level"]
        .as_str()
        .unwrap_or_else(|| panic!("{}: missing level", ctx()));
    assert!(
        ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"].contains(&level),
        "{}: unexpected level {level}",
        ctx()
    );
    assert!(
        v["target"].as_str().map(|t| !t.is_empty()).unwrap_or(false),
        "{}: missing/empty target (component)",
        ctx()
    );
    assert!(v["msg"].is_string(), "{}: msg must be a string", ctx());
    assert_eq!(
        v["app_version"].as_str(),
        Some(expected_version),
        "{}: app_version must be stamped on every line",
        ctx()
    );
    assert_eq!(
        v["server_pid"].as_u64(),
        Some(expected_pid as u64),
        "{}: server_pid must be stamped on every line",
        ctx()
    );
}

fn find_line<'a>(lines: &'a [LogLine], msg: &str) -> Option<&'a LogLine> {
    lines.iter().find(|l| l.value["msg"].as_str() == Some(msg))
}

fn find_all<'a>(lines: &'a [LogLine], msg: &str) -> Vec<&'a LogLine> {
    lines
        .iter()
        .filter(|l| l.value["msg"].as_str() == Some(msg))
        .collect()
}

// ── test 1: full flows + schema + correlation ────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diag01_full_flow_log_schema_and_correlation() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let mut boot = boot_server(&server_binary, home.path()).await;
    let server_pid = boot.child.id();
    let base = format!("http://127.0.0.1:{}", boot.port);
    let client = reqwest::Client::new();

    // ── auth flow: bad token 401, good token 200 (HTTP level) ──
    let bad = client
        .get(format!("{base}/api/settings"))
        .header("x-auth-token", "definitely-the-wrong-token")
        .send()
        .await
        .expect("bad-token request");
    assert_eq!(bad.status().as_u16(), 401, "wrong token must 401");
    let ok = client
        .get(format!("{base}/api/settings"))
        .header("x-auth-token", AUTH_TOKEN)
        .send()
        .await
        .expect("good-token request");
    assert!(ok.status().is_success(), "good token must succeed");

    // The reported version, to cross-check the log's app_version stamp.
    let version_resp = client
        .get(format!("{base}/api/version"))
        .header("x-auth-token", AUTH_TOKEN)
        .send()
        .await
        .expect("version request");
    let reported_version = version_resp
        .json::<serde_json::Value>()
        .await
        .expect("version json")["currentVersion"]
        .as_str()
        .expect("currentVersion string")
        .to_string();

    // ── recoverable-error flow: authenticated 404 ──
    let not_found = client
        .get(format!(
            "{base}/api/session-directory/definitely-missing-id-diag01"
        ))
        .header("x-auth-token", AUTH_TOKEN)
        .send()
        .await
        .expect("404 request");
    assert_eq!(not_found.status().as_u16(), 404);

    // ── WS flow: hello -> ready; ping -> pong ──
    let ws_url = format!("ws://127.0.0.1:{}/ws", boot.port);
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("ws connect");
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "hello",
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "token": AUTH_TOKEN,
        }),
    )
    .await;
    wait_for_any_message_type(&mut ws, &["ready"], Duration::from_secs(5))
        .await
        .expect("expected `ready` handshake frame");
    send_json(&mut ws, &serde_json::json!({ "type": "ping" })).await;
    let pong = wait_for_any_message_type(&mut ws, &["pong"], Duration::from_secs(5))
        .await
        .expect("expected a `pong` reply");
    assert!(pong.1["timestamp"].is_string(), "pong carries a timestamp");

    // ── terminal flow: create -> kill ──
    let term_rid = format!("diag01-term-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "terminal.create",
            "requestId": term_rid,
            "mode": "shell",
            "shell": "system",
        }),
    )
    .await;
    let created = wait_for_any_message_type(
        &mut ws,
        &["terminal.created", "error"],
        Duration::from_secs(15),
    )
    .await
    .expect("expected terminal.created");
    assert_eq!(
        created.0, "terminal.created",
        "create must succeed: {created:?}"
    );
    let terminal_id = created.1["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    send_json(
        &mut ws,
        &serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id }),
    )
    .await;
    // The kill's `terminal.exit` wire frame fans out to ATTACHED viewers
    // only, and this test never attaches — the artifact under test is the
    // LOG, so wait for the `terminal.killed` JSONL event directly (the
    // writer flushes synchronously per line).
    let log_for_kill = home.path().join(".freshell/logs/rust-server.jsonl");
    let kill_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let have_kill = std::fs::read_to_string(&log_for_kill)
            .map(|content| {
                content.lines().any(|line| {
                    line.contains("\"terminal.killed\"") && line.contains(terminal_id.as_str())
                })
            })
            .unwrap_or(false);
        if have_kill || Instant::now() >= kill_deadline {
            assert!(have_kill, "terminal.killed never reached the log");
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ── provider flow: freshcodex session against the fake sidecar ──
    let agent_rid = format!("diag01-agent-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.create",
            "requestId": agent_rid,
            "sessionType": "freshcodex",
            "provider": "codex",
        }),
    )
    .await;
    match wait_for_any_message_type(
        &mut ws,
        &["freshAgent.created", "freshAgent.createFailed"],
        Duration::from_secs(50),
    )
    .await
    {
        Some((got_type, _)) if got_type == "freshAgent.created" => {}
        other => panic!("expected freshAgent.created, got {other:?}"),
    }

    // Clean close, then the quit flow.
    ws.close(None).await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    sigterm_and_reap(&mut boot).await;

    // ── parse + assert ──
    let (raw, lines) = parse_log(home.path());
    assert!(!lines.is_empty(), "log must not be empty");
    let raw_lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    for (line, raw_line) in lines.iter().zip(raw_lines.iter()) {
        assert_line_schema(line, &reported_version, server_pid, raw_line);
    }
    assert!(
        !raw.contains(AUTH_TOKEN),
        "the real AUTH_TOKEN value leaked into the log"
    );

    // Lifecycle: exactly one coherent start/stop chain, in order.
    let started = find_line(&lines, "server.started").expect("server.started must be logged");
    for field in ["bind", "port", "boot_id", "instance_id", "commit", "dirty"] {
        assert!(
            started.value.get(field).is_some(),
            "server.started must carry {field}"
        );
    }
    let stopping = find_line(&lines, "server.stopping").expect("server.stopping must be logged");
    assert_eq!(stopping.value["signal"].as_str(), Some("SIGTERM"));
    // The forensics record carries `event = "shutdown_forensics"` (its msg
    // is prose), so match on the event field, not msg.
    assert!(
        lines
            .iter()
            .any(|l| l.value["event"].as_str() == Some("shutdown_forensics")),
        "shutdown_forensics event must be present between stopping and stopped"
    );
    let stopped = find_line(&lines, "server.stopped").expect("server.stopped must be logged");
    assert!(
        started.index < stopping.index && stopping.index < stopped.index,
        "lifecycle order must be started < stopping < stopped ({} < {} < {})",
        started.index,
        stopping.index,
        stopped.index
    );

    // Correlation: one connection id threads established -> terminal.created
    // -> closed; one terminal id threads created -> killed.
    let established = find_line(&lines, "ws.connection.established")
        .expect("ws.connection.established must be logged");
    let conn_id = established.value["connection_id"]
        .as_u64()
        .expect("connection_id integer");
    let closed =
        find_line(&lines, "ws.connection.closed").expect("ws.connection.closed must be logged");
    assert_eq!(closed.value["connection_id"].as_u64(), Some(conn_id));
    assert!(
        closed.value["reason"]
            .as_str()
            .map(|r| !r.is_empty())
            .unwrap_or(false),
        "connection.closed carries a reason"
    );

    let term_created =
        find_line(&lines, "terminal.created").expect("terminal.created event must be logged");
    assert_eq!(
        term_created.value["terminal_id"].as_str(),
        Some(terminal_id.as_str())
    );
    assert!(
        term_created.value["pid"].as_u64().unwrap_or(0) > 0,
        "terminal.created carries the child pid (process ownership)"
    );
    assert_eq!(
        term_created.value["connection_id"].as_u64(),
        Some(conn_id),
        "terminal.created must inherit the serving connection's id"
    );
    let term_killed =
        find_line(&lines, "terminal.killed").expect("terminal.killed event must be logged");
    assert_eq!(
        term_killed.value["terminal_id"].as_str(),
        Some(terminal_id.as_str())
    );

    let agent_created = find_line(&lines, "freshagent.session.created")
        .expect("freshagent.session.created must be logged");
    assert_eq!(agent_created.value["provider"].as_str(), Some("codex"));
    assert!(
        agent_created.value["session_id"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "freshagent.session.created carries a session_id"
    );
    // The sidecar spawn event: the schema documents `pid` (the process just
    // created) and static `provider` -- never a prompt or token. The
    // pid<->session join is the same session's adjacent created/reaped
    // events (spawned can precede session minting on the create path).
    let sidecar = find_line(&lines, "freshagent.sidecar.spawned")
        .expect("freshagent.sidecar.spawned must be logged");
    assert!(
        sidecar.value["pid"].as_u64().unwrap_or(0) > 0,
        "sidecar.spawned carries the spawned process pid"
    );
    assert_eq!(
        sidecar.value["provider"].as_str(),
        Some("codex"),
        "sidecar.spawned carries its provider"
    );

    // Error entries: warn-level, route-correlated, distinct request ids.
    let http_events = find_all(&lines, "http_request");
    let unauth = http_events
        .iter()
        .find(|l| {
            l.value["status"].as_u64() == Some(401)
                && l.value["route"].as_str() == Some("/api/settings")
        })
        .expect("a warn-level 401 /api/settings entry");
    assert_eq!(unauth.value["level"].as_str(), Some("WARN"));
    let four_oh_four = http_events
        .iter()
        .find(|l| {
            l.value["status"].as_u64() == Some(404)
                && l.value["route"]
                    .as_str()
                    .map(|r| r.contains("session-directory"))
                    .unwrap_or(false)
        })
        .expect("a 404 session-directory entry");
    let rid_401 = unauth.value["request_id"].as_str().expect("401 request_id");
    let rid_404 = four_oh_four.value["request_id"]
        .as_str()
        .expect("404 request_id");
    assert_ne!(rid_401, rid_404, "request ids must be distinct per request");
}

// ── test 2: restart writes two coherent lifecycles into one log ─────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diag01_restart_writes_two_coherent_lifecycles() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");

    let mut boot_a = boot_server(&server_binary, home.path()).await;
    let pid_a = boot_a.child.id();
    sigterm_and_reap(&mut boot_a).await;

    let mut boot_b = boot_server(&server_binary, home.path()).await;
    let pid_b = boot_b.child.id();
    sigterm_and_reap(&mut boot_b).await;

    assert_ne!(pid_a, pid_b, "two boots are two processes");

    let (raw, lines) = parse_log(home.path());
    let raw_lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    // The /api/version cross-check needs a live server, so assert the stamp
    // against the build's own APP_VERSION here ("0.7.0") -- test 1 already
    // proves the stamp equals the reported version; here we assert the
    // per-boot pid attribution, which is the restart-specific property.
    for (line, raw_line) in lines.iter().zip(raw_lines.iter()) {
        assert_line_schema(
            line,
            "0.7.0",
            line.value["server_pid"].as_u64().unwrap_or(0) as u32,
            raw_line,
        );
    }

    let starteds = find_all(&lines, "server.started");
    let stoppeds = find_all(&lines, "server.stopped");
    let stoppings = find_all(&lines, "server.stopping");
    assert_eq!(starteds.len(), 2, "two boots -> two server.started events");
    assert_eq!(stoppeds.len(), 2, "two boots -> two server.stopped events");
    assert_eq!(
        stoppings.len(),
        2,
        "two boots -> two server.stopping events"
    );

    let (a_start, b_start) = (starteds[0], starteds[1]);
    let (a_stop, b_stop) = (stoppeds[0], stoppeds[1]);
    assert!(
        a_start.index < a_stop.index
            && a_stop.index < b_start.index
            && b_start.index < b_stop.index,
        "lifecycles must interleave cleanly: A.started < A.stopped < B.started < B.stopped"
    );

    // Same persistent installation identity, distinct per-boot identity.
    assert_eq!(
        a_start.value["instance_id"], b_start.value["instance_id"],
        "instance_id persists per home (CFG-07)"
    );
    assert_ne!(
        a_start.value["boot_id"], b_start.value["boot_id"],
        "boot_id is per-boot"
    );
    assert_eq!(a_start.value["server_pid"].as_u64(), Some(pid_a as u64));
    assert_eq!(b_start.value["server_pid"].as_u64(), Some(pid_b as u64));

    // Same version across boots; timestamps non-decreasing in file order
    // (append-only chronological stream).
    assert_eq!(a_start.value["app_version"], b_start.value["app_version"]);
    let mut prev: Option<chrono::DateTime<chrono::FixedOffset>> = None;
    for line in &lines {
        let ts = chrono::DateTime::parse_from_rfc3339(line.value["ts"].as_str().unwrap())
            .expect("RFC3339 ts");
        if let Some(prev) = prev {
            assert!(ts >= prev, "log timestamps must be non-decreasing");
        }
        prev = Some(ts);
    }
}
