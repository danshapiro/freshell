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
//!
//! DELIBERATE DEVIATION (Task 10, kata ynfn): the parity checklist's
//! acceptance text "terminate exact terminal/provider/extension trees"
//! (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:615`)
//! is deliberately INVERTED for TRACKED codex terminal-pane sidecars — the
//! launch manager's adopted, record-bearing spawns are now RETAINED across a
//! graceful shutdown ("killing sidecars at shutdown is NOT acceptable —
//! surviving restarts is a feature"). This suite's coverage is untouched by
//! that: its codex leg is a freshagent-lane sidecar (`freshAgent.create
//! {sessionType:"freshcodex"}`) plus a shell PTY. The freshagent lane
//! remains OUTSIDE the *retention* scope — it still kills its sidecars at
//! graceful shutdown, so this test doubles as the tripwire that retention
//! did not leak into the freshagent lane or shell-PTY reaping — but it is
//! now INSIDE *tracking* (kata wfah): the lane writes a durable
//! `lane:"freshAgent"` record at spawn, and the next server generation's
//! boot reconcile + grace-delayed sweep reaps a tracked orphan left behind
//! by an unclean death (proven below by
//! `sigkill_restart_reaps_tracked_freshagent_sidecar_via_store`). The
//! retention behavior itself is pinned by
//! `crates/freshell-codex/tests/launch_lifecycle.rs`'s Task 10 section.

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
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
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

/// Directory of durable sidecar records for a test server home.
fn sidecar_store_records(home: &std::path::Path) -> Vec<serde_json::Value> {
    let dir = home.join(".freshell/rust-codex-sidecars");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

/// The freshagent-lane fixture sidecar of a test server, if any: its cmdline
/// contains the fake app-server script name.
fn find_freshagent_sidecar_pid(server_pid: u32) -> Option<u32> {
    descendant_pids(server_pid)
        .into_iter()
        .find(|&pid| pid_cmdline(pid).contains("fake-app-server"))
}

/// Bounded `wait()` for a just-signalled std `Child`: poll `try_wait` until
/// the process exits or the budget expires, escalating to SIGKILL so the
/// caller's stderr drain can never block forever (`read_to_string` waits for
/// the pipe EOF, which only the process's exit produces). All waits are
/// `tokio::time::sleep`, matching the async discipline of the rest of this
/// file.
async fn reaped_wait(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Panic-path cleanup for the cross-restart test's spawned pids.
/// `std::process::Child` has no kill-on-drop, and the SIGKILL test
/// deliberately leaves the fixture sidecar running across server1's death,
/// so any assertion failure unwinding between a spawn and that spawn's own
/// teardown arm would strand a live server and/or sidecar past test end.
/// The guard SIGKILLs every registered pid on drop unless disarmed: panics
/// kill the registered set; the success path (and every explicit-cleanup
/// failure arm) disarms once its own teardown has run, so a later
/// `panic!`/`assert!` never double-signals.
struct KillOnPanic {
    pids: Vec<u32>,
    armed: bool,
}

impl KillOnPanic {
    fn new(pids: Vec<u32>) -> Self {
        Self { pids, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for KillOnPanic {
    fn drop(&mut self) {
        if self.armed {
            for &pid in &self.pids {
                let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            }
        }
    }
}

/// wfah Task 5: the cross-restart proof. Generation 1 boots, spawns a
/// freshcodex fresh-agent sidecar (a durable `lane:"freshAgent"` record names
/// it), and is then `kill -9`'d — no graceful shutdown, no Drop, no record
/// scrub, so the sidecar survives orphaned (that is precisely the bug class
/// being fixed). Generation 2 boots on the SAME home; its boot reconcile
/// holds the record and the grace-delayed sweep (`1000ms` via
/// `FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS`) verifies the survivor, finds no
/// active thread on the fixture, reaps it, and removes the record. The test
/// asserts the full chain: record exists -> SIGKILL -> orphan survives ->
/// generation 2 -> orphan gone AND record scrubbed.
///
/// RED (pre-Tasks 1-4): the freshagent lane wrote no record, so the run
/// fails at the "no tracked record for pid" assertion and generation 2's
/// sweep has nothing to reap — the orphan survives.
#[tokio::test]
async fn sigkill_restart_reaps_tracked_freshagent_sidecar_via_store() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port1 = allocate_ephemeral_port();
    seed_fresh_agent_enabled(home.path());

    // Generation 1: boot, create a freshcodex fresh-agent session.
    let mut server1 = Command::new(&server_binary)
        .env("PORT", port1.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server #1");
    // Panic guard: any panic between here and this test's own SIGKILL arm
    // below (assertion failures, ws handshake errors, ...) would otherwise
    // unwind past `server1`'s drop and leak a live server plus its fixture
    // sidecar past test end. The sidecar pid is registered as soon as it is
    // identified; server1 is de-registered right after this test reaps it,
    // so a post-SIGKILL panic can never signal a recycled pid.
    let mut panic_guard = KillOnPanic::new(vec![server1.id()]);
    if !wait_for_health(port1, &mut server1, Duration::from_secs(15)).await {
        // Kill (and reap) BEFORE draining stderr: `read_to_string` blocks
        // until the pipe EOFs, which only happens once the process exits.
        let _ = server1.kill();
        let _ = server1.wait();
        let stderr = drain_stderr(&mut server1);
        // This arm already reaped everything it started.
        panic_guard.disarm();
        panic!("server #1 never became healthy; stderr:\n{stderr}");
    }
    let (mut ws, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port1}/ws"))
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
    wait_for_message_type(&mut ws, "ready", Duration::from_secs(5))
        .await
        .expect("ready handshake");
    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.create",
            "requestId": "rid-wfah-sigkill",
            "sessionType": "freshcodex",
            "provider": "codex",
        }),
    )
    .await;
    // Generous: `SIDECAR_START_BUDGET` is 45s server-side — mirror the
    // graceful test's 50s frame budget.
    match wait_for_any_message_type(
        &mut ws,
        &["freshAgent.created", "freshAgent.createFailed"],
        Duration::from_secs(50),
    )
    .await
    {
        Some((got, _)) if got == "freshAgent.created" => {}
        other => {
            // Failure-path teardown mirrors the success path: SIGTERM lets
            // the server gracefully reap any sidecar it already spawned
            // before we panic, so no fixture tree leaks past test end.
            let _ = unsafe { libc::kill(server1.id() as libc::pid_t, libc::SIGTERM) };
            let _ = reaped_wait(&mut server1, Duration::from_secs(10)).await;
            let log_tail =
                std::fs::read_to_string(home.path().join(".freshell/logs/rust-server.jsonl"))
                    .unwrap_or_default();
            let stderr = drain_stderr(&mut server1);
            // The SIGTERM + reaped_wait above already killed server1 and let
            // it gracefully reap any sidecar it held.
            panic_guard.disarm();
            panic!(
                "expected freshAgent.created, got {other:?}; server #1 stderr:\n{stderr}\nlog tail:\n{log_tail}"
            );
        }
    }

    // The sidecar exists, and a durable tracked record names it.
    let server1_pid = server1.id();
    let sidecar_pid = match find_freshagent_sidecar_pid(server1_pid) {
        Some(pid) => pid,
        None => {
            // Explicit-cleanup arm: SIGTERM (whose graceful shutdown reaps
            // any sidecar the server holds), not the guard's SIGKILL -- a
            // guard kill of server1 alone could strand the very sidecar this
            // arm failed to identify.
            let _ = unsafe { libc::kill(server1_pid as libc::pid_t, libc::SIGTERM) };
            let _ = reaped_wait(&mut server1, Duration::from_secs(10)).await;
            let stderr = drain_stderr(&mut server1);
            panic_guard.disarm();
            panic!(
                "expected a fixture sidecar among the server's descendants; \
                 server #1 stderr:\n{stderr}"
            );
        }
    };
    panic_guard.pids.push(sidecar_pid);
    let deadline = Instant::now() + Duration::from_secs(10);
    let record = loop {
        let found = sidecar_store_records(home.path())
            .into_iter()
            .find(|r| r["pid"].as_u64() == Some(sidecar_pid as u64));
        if let Some(record) = found {
            break record;
        }
        assert!(
            Instant::now() < deadline,
            "no tracked record for pid {sidecar_pid}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(
        record["lane"].as_str(),
        Some("freshAgent"),
        "freshagent rows carry the lane marker: {record}"
    );
    assert_eq!(record["state"]["kind"].as_str(), Some("active"));
    drop(ws);

    // THE UNCLEAN DEATH: no graceful shutdown, no Drop, no record scrub.
    let kill_rc = unsafe { libc::kill(server1_pid as libc::pid_t, libc::SIGKILL) };
    assert_eq!(kill_rc, 0, "SIGKILL to the server must land");
    // Blocking std wait: SIGKILL landed, so the zombie is reaped promptly.
    let _ = server1.wait();
    // server1 is now dead and reaped by the test's own hand: de-register it
    // so a later panic can never SIGKILL a recycled pid. The deliberately
    // orphaned sidecar stays registered until the teardown below completes.
    panic_guard.pids.retain(|&p| p != server1_pid);
    // The orphan survives (that is precisely the bug class being fixed).
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        pid_alive(sidecar_pid),
        "the sidecar must still be alive after the unclean death — \
         otherwise there is nothing to reap"
    );

    // Generation 2 on the SAME home: boot reconcile + shortened grace sweep.
    let port2 = allocate_ephemeral_port();
    let mut server2 = Command::new(&server_binary)
        .env("PORT", port2.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env("FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS", "1000")
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server #2");
    if !wait_for_health(port2, &mut server2, Duration::from_secs(15)).await {
        // Same kill-then-drain discipline as generation 1, plus the leak
        // guard for the generation-1 orphan generation 2 was about to reap.
        // The guard signal is gated on identity re-verification (never
        // signal a pid the test did not spawn AND verify): without a
        // healthy server2 no sweep ran, so the orphan should still be ours
        // -- but the discipline is not conditional on expectation.
        if pid_cmdline(sidecar_pid).contains("fake-app-server") {
            let _ = unsafe { libc::kill(sidecar_pid as libc::pid_t, libc::SIGKILL) };
        }
        let _ = server2.kill();
        let _ = server2.wait();
        let stderr = drain_stderr(&mut server2);
        // This arm killed server2 and the registered sidecar itself.
        panic_guard.disarm();
        panic!("server #2 never became healthy; stderr:\n{stderr}");
    }

    // Within the grace + probe budget, the orphan is reaped and its record removed.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut reaped = false;
    while Instant::now() < deadline {
        let gone = !pid_alive(sidecar_pid);
        let scrubbed = !sidecar_store_records(home.path())
            .iter()
            .any(|r| r["pid"].as_u64() == Some(sidecar_pid as u64));
        if gone && scrubbed {
            reaped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // Leak guard + teardown: never leave the fixture running past the test.
    // The guard SIGKILL is gated on identity re-verification
    // (`pid_cmdline(...).contains("fake-app-server")`): if generation 2's
    // sweep reaped the orphan and the row/pid checks raced an unrelated
    // recycle of the pid, this must not signal a foreign process (never
    // signal a pid the test did not spawn AND verify). A genuinely
    // not-reaped orphan still matches its fixture cmdline and is killed.
    if !reaped && pid_cmdline(sidecar_pid).contains("fake-app-server") {
        let _ = unsafe { libc::kill(sidecar_pid as libc::pid_t, libc::SIGKILL) };
    }
    let _ = unsafe { libc::kill(server2.id() as libc::pid_t, libc::SIGTERM) };
    let _ = reaped_wait(&mut server2, Duration::from_secs(10)).await;
    // Drain ONLY after server2 has exited (see `reaped_wait`): the pipe EOFs
    // exactly once the process and every inherited-writer child are gone.
    let server2_stderr = drain_stderr(&mut server2);
    let log_tail = std::fs::read_to_string(home.path().join(".freshell/logs/rust-server.jsonl"))
        .unwrap_or_default();

    // The test's own reaping/teardown is complete: on the success path the
    // sweep already reaped the orphan, and on the failure path the leak
    // guard above killed it. Disarm so a failing final assertion does not
    // re-signal anything.
    panic_guard.disarm();

    assert!(
        reaped,
        "the next generation must reap the tracked orphan. sidecar_pid={sidecar_pid} alive={} server2 stderr:\n{server2_stderr}\nlog tail:\n{log_tail}",
        pid_alive(sidecar_pid),
    );
}
