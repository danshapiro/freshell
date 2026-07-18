//! SAFE-11 + TERM-22 outer, outcome-oriented acceptance test: "an update
//! restart never leaves orphan CLIs." Boots the REAL `freshell-server`
//! binary on an ephemeral loopback port with an isolated tempdir home,
//! drives the real `/ws` protocol to create a real PTY shell terminal
//! running `sleep 300` PLUS a real fake-codex fresh-agent sidecar (via the
//! committed `CODEX_CMD` fixture wrapper -- the SAME fixture
//! `freshell-freshagent`'s own Codex lifecycle tests use, so this exercises
//! a genuine subprocess spawn, not a mock), records every descendant PID of
//! the server process, sends SIGTERM, and asserts:
//!
//! 1. the process exits with status 0 within 5s of the signal, and
//! 2. every recorded descendant PID is actually gone afterward.
//!
//! See `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`
//! (SAFE-11, TERM-22) for the full acceptance text this proves. Black-box
//! by necessity: `freshell-server` is a `[[bin]]`-only crate with no `[lib]`
//! target, and reaping is only meaningful at OS-process granularity anyway
//! -- there is no in-process way to observe "did the child process actually
//! die" other than asking the OS.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::MaybeTlsStream;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef-shutdown-reap";

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Locate the compiled `freshell-server` binary (same discovery order as
/// `diag01_diag03_logging.rs`): explicit override, sibling of this test
/// binary, then a self-sufficient `cargo build --bin freshell-server`.
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

/// The committed Node fake codex app-server fixture
/// (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`) --
/// the SAME script `freshell-freshagent`'s own Codex lifecycle tests use via
/// `CODEX_CMD` (`crates/freshell-freshagent/src/codex.rs`'s
/// `fake_codex_app_server_cmd`), so a `freshAgent.create { sessionType:
/// "freshcodex" }` here spawns a real subprocess + real WS `initialize`/
/// `thread/start` round-trip rather than an in-process fake.
fn fake_codex_app_server_cmd() -> String {
    format!(
        "{}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
        env!("CARGO_MANIFEST_DIR")
    )
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

async fn send_json(ws: &mut WsStream, value: &serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("ws send");
}

/// Drain inbound frames until one with `"type": type_name` arrives, or the
/// timeout elapses (returns `None`).
async fn wait_for_message_type(
    ws: &mut WsStream,
    type_name: &str,
    timeout: Duration,
) -> Option<serde_json::Value> {
    wait_for_any_message_type(ws, &[type_name], timeout)
        .await
        .map(|(_, value)| value)
}

/// Drain inbound frames until one whose `"type"` is any of `type_names`
/// arrives (returning the matched type name + the full frame), or the
/// timeout elapses (returns `None`). Checking several types in ONE drain
/// loop matters: a single-type wait would silently discard a same-request
/// failure frame (e.g. `freshAgent.createFailed`) while looking past it for
/// success, making failures indistinguishable from a hang.
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

/// Seed `<home>/.freshell/config.json` with `freshAgent.enabled: true` BEFORE
/// the server boots. `freshAgent.create` is gated on this flag
/// (`crates/freshell-server/src/main.rs`'s `fresh_codex_state` construction
/// comment: "the create gate is the SHARED settings.freshAgent.enabled
/// flag"), and the default is `false`
/// (`crates/freshell-protocol/src/settings.rs`'s `SettingsFreshAgent`
/// default) — an isolated fresh tempdir home has no config file at all, so
/// without this seed every `freshAgent.create` in this test would fail
/// before ever reaching the codex sidecar spawn this test needs to exist.
///
/// The persisted document nests the actual settings tree under a top-level
/// `"settings"` key (`crates/freshell-server/src/settings_store.rs`'s
/// `load_full_settings`: `doc.get("settings")`, else the file is treated as
/// absent and defaults are used untouched) — a bare `{"freshAgent": ...}`
/// with no wrapper is silently ignored.
fn seed_fresh_agent_enabled(home: &Path) {
    let dir = home.join(".freshell");
    std::fs::create_dir_all(&dir).expect("create .freshell dir");
    std::fs::write(
        dir.join("config.json"),
        serde_json::json!({ "settings": { "freshAgent": { "enabled": true } } }).to_string(),
    )
    .expect("seed config.json");
}

/// Every live child of `pid` per `/proc/<pid>/task/*/children` (Linux only --
/// this test crate already runs exclusively under Linux CI/sandbox).
fn direct_children(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let task_dir = format!("/proc/{pid}/task");
    let Ok(entries) = std::fs::read_dir(&task_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let children_path = entry.path().join("children");
        if let Ok(contents) = std::fs::read_to_string(&children_path) {
            for tok in contents.split_whitespace() {
                if let Ok(cpid) = tok.parse::<u32>() {
                    out.push(cpid);
                }
            }
        }
    }
    out
}

/// Every descendant of `pid`, recursively (BFS over `direct_children`).
fn descendant_pids(pid: u32) -> Vec<u32> {
    let mut all = Vec::new();
    let mut frontier = vec![pid];
    while let Some(p) = frontier.pop() {
        for child in direct_children(p) {
            if !all.contains(&child) {
                all.push(child);
                frontier.push(child);
            }
        }
    }
    all
}

/// A pid counts as "alive" (still owning resources) only if it exists AND is
/// not a zombie. A zombie (`/proc/<pid>/stat` state `Z`) has already been
/// killed and holds no CPU/memory/fds -- it is a bookkeeping-only entry
/// waiting for ITS parent (or, once orphaned, the nearest subreaper such as
/// init/systemd) to reap it via `wait()`. That reparent-and-reap happens
/// automatically and near-instantly on any orphan; it is not the "leaked
/// child process" SAFE-11 cares about, so a test asserting "no orphans"
/// must not conflate a transient zombie with a genuinely running one.
fn pid_alive(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
        return false;
    };
    // Format: `pid (comm) state ...` -- comm may itself contain spaces/parens,
    // so parse from the LAST `)` rather than splitting naively.
    let Some(after_comm) = stat.rsplit_once(')') else {
        return true; // Unparseable: assume alive rather than under-count.
    };
    !matches!(after_comm.1.split_whitespace().next(), Some("Z"))
}

/// Best-effort `/proc/<pid>/cmdline` for diagnostics (NUL-joined argv reassembled
/// with spaces; empty string if the process is already gone or unreadable).
fn pid_cmdline(pid: u32) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .ok()
        .map(|bytes| {
            bytes
                .split(|&b| b == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_reaps_terminal_and_codex_sidecar_within_5s() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    seed_fresh_agent_enabled(home.path());

    let mut child = Command::new(&server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
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

    let ws_url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("ws connect");
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "hello",
            "protocolVersion": 7,
            "token": AUTH_TOKEN,
        }),
    )
    .await;
    wait_for_message_type(&mut ws, "ready", Duration::from_secs(5))
        .await
        .expect("expected a `ready` handshake frame");

    // 1) A real PTY shell terminal, then type `sleep 300` into it so it has
    // a genuine long-running child process (not just an idle shell prompt).
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "terminal.create",
            "requestId": "rid-term-1",
            "mode": "shell",
            "shell": "system",
        }),
    )
    .await;
    let created = wait_for_message_type(&mut ws, "terminal.created", Duration::from_secs(5))
        .await
        .expect("expected `terminal.created`");
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminal.created.terminalId")
        .to_string();
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": "sleep 300\n",
        }),
    )
    .await;
    // Give the shell a moment to actually exec `sleep` before we snapshot pids.
    tokio::time::sleep(Duration::from_millis(750)).await;

    // 2) A real fake-codex fresh-agent session -- spawns the fixture's Node
    // process as the Codex app-server sidecar.
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "rid-agent-1",
            "sessionType": "freshcodex",
            "provider": "codex",
        }),
    )
    .await;
    // Generous: `FreshCodexState`'s own sidecar-start budget is 45s
    // (`SIDECAR_START_BUDGET`, `crates/freshell-freshagent/src/codex.rs`),
    // covering spawn + WS connect + `initialize` + `thread/start`.
    match wait_for_any_message_type(
        &mut ws,
        &["freshAgent.created", "freshAgent.createFailed"],
        Duration::from_secs(50),
    )
    .await
    {
        Some((got_type, _)) if got_type == "freshAgent.created" => {}
        other => {
            let log_tail =
                std::fs::read_to_string(home.path().join(".freshell/logs/rust-server.jsonl"))
                    .unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
            let stderr = drain_stderr(&mut child);
            panic!(
                "expected `freshAgent.created`, got {other:?} (or nothing within the \
                 timeout); server stderr:\n{stderr}\nrust-server.jsonl:\n{log_tail}"
            );
        }
    }
    tokio::time::sleep(Duration::from_millis(750)).await;

    let server_pid = child.id();
    let descendants = descendant_pids(server_pid);
    assert!(
        descendants.len() >= 2,
        "expected at least the shell + the codex sidecar as live descendants \
         of pid {server_pid}, got {descendants:?}"
    );
    assert!(
        descendants.iter().all(|&pid| pid_alive(pid)),
        "every recorded descendant must be alive right before the SIGTERM \
         (test setup, not the assertion under test): {descendants:?}"
    );

    // The signal under test: mirrors the oracle harness's `stop()` / a real
    // update-restart, per the delegation's outer-test contract.
    let kill_rc = unsafe { libc::kill(server_pid as libc::pid_t, libc::SIGTERM) };
    assert_eq!(kill_rc, 0, "SIGTERM to the server pid must succeed");

    let signal_sent_at = Instant::now();
    let deadline = signal_sent_at + Duration::from_secs(5);
    let mut exit_status = None;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            exit_status = Some(status);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let elapsed = signal_sent_at.elapsed();

    let Some(status) = exit_status else {
        let still_alive: Vec<u32> = descendants
            .iter()
            .copied()
            .filter(|&pid| pid_alive(pid))
            .collect();
        let _ = child.kill();
        panic!(
            "server did not exit within 5s of SIGTERM (elapsed {elapsed:?}); \
             leaked descendant pids: {still_alive:?}"
        );
    };

    assert!(
        status.success(),
        "graceful SIGTERM shutdown must exit 0, got {status:?} after {elapsed:?}"
    );
    assert!(
        elapsed <= Duration::from_secs(5),
        "shutdown must complete within the 5s hard timeout, took {elapsed:?}"
    );

    let still_alive: Vec<(u32, String)> = descendants
        .iter()
        .copied()
        .filter(|&pid| pid_alive(pid))
        .map(|pid| (pid, pid_cmdline(pid)))
        .collect();
    assert!(
        still_alive.is_empty(),
        "orphaned descendant pids after a graceful shutdown: {still_alive:?} \
         (all recorded descendants: {descendants:?})"
    );
}
