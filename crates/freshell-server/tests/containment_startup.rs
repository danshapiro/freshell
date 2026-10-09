//! Containment start-up prelude (black-box): boots the REAL `freshell-server`
//! binary against an isolated temp home + ephemeral loopback port and proves
//! the three things the server does before it starts anything:
//!
//! 1. it removes an inherited unit tag (`FRESHELL_UNIT_ID`, and the v1 Codex
//!    sidecar tag `FRESHELL_CODEX_SIDECAR_ID`) from its own environment, so a
//!    server started inside an agent pane never hands that pane's tag to the
//!    terminals and sidecars it starts;
//! 2. it logs exactly one `containment.self_check` line confirming the
//!    facilities every confirmed stop rests on (pidfd and
//!    `/proc/<pid>/task/<tid>/children`), plus a stderr line cloud e2e logs carry;
//! 3. it raises its open-file soft limit to the hard limit, so fd exhaustion
//!    under the common 1024 default cannot surface as stop errors, while
//!    every child it starts (a shell pane, an ordinary helper process) still
//!    starts with the soft limit the server itself was started with.
//!
//! Harness conventions are intentionally duplicated from
//! `diag01_lifecycle_logging.rs` (this repo's black-box test files each carry
//! their own small copy). Every process signalled here was spawned here.
#![cfg(target_os = "linux")]

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

const AUTH_TOKEN: &str = "containment-startup-outer-test-secret-5d81e2";
const INHERITED_UNIT_ID: &str = "u0123456789abcdef0123456789abcdef";
const INHERITED_LEGACY_TAG: &str = "legacy-tag";
/// Set on the server so the shell's environment provably came from it.
const MARKER_ENV: &str = "FRESHELL_CONTAINMENT_STARTUP_TEST_MARKER";

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

/// The committed fake codex app-server fixture, so nothing the server might
/// start can reach a real `codex`.
fn fake_codex_app_server_cmd() -> String {
    format!(
        "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// The server command with this suite's hermetic environment: isolated home,
/// no inherited unit tags (a test runner started inside a Freshell pane must
/// not change the outcome), and no ambient log-sink overrides.
fn server_command(server_binary: &Path, home: &Path, port: u16) -> Command {
    let mut cmd = Command::new(server_binary);
    cmd.env("PORT", port.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
        .env("FRESHELL_HOME", home)
        .env("HOME", home)
        .env("CODEX_CMD", fake_codex_app_server_cmd())
        .env(MARKER_ENV, "1")
        .env_remove("FRESHELL_UNIT_ID")
        .env_remove("FRESHELL_CODEX_SIDECAR_ID")
        .env_remove("RUST_LOG")
        .env_remove("FRESHELL_LOG_DIR")
        .env_remove("FRESHELL_LOG_MAX_BYTES")
        .env_remove("FRESHELL_LOG_MAX_BACKUPS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    cmd
}

struct Boot {
    child: Child,
    port: u16,
    /// Everything the server wrote to stderr so far (a reader thread drains
    /// the pipe continuously, so a chatty server can never block on it).
    stderr: Arc<Mutex<String>>,
}

impl Boot {
    fn stderr_text(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Bounded wait for `needle` on the server's stderr.
    async fn wait_stderr_contains(&self, needle: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            if self.stderr_text().contains(needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

async fn boot(mut cmd: Command, port: u16) -> Boot {
    let mut child = cmd.spawn().expect("spawn freshell-server");
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock()
                    .unwrap()
                    .push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
    }
    let mut boot = Boot {
        child,
        port,
        stderr,
    };
    if !wait_for_health(&mut boot, Duration::from_secs(20)).await {
        let _ = boot.child.kill();
        let _ = boot.child.wait();
        panic!(
            "freshell-server never became healthy on port {port}; stderr:\n{}",
            boot.stderr_text()
        );
    }
    boot
}

async fn wait_for_health(boot: &mut Boot, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let url = format!("http://127.0.0.1:{}/api/health", boot.port);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = boot.child.try_wait() {
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

/// SIGTERM the server this test spawned and require a graceful exit 0
/// within 5 s (the server's own shutdown contract).
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

// ── log helpers ──────────────────────────────────────────────────────────

fn log_lines(home: &Path) -> Vec<serde_json::Value> {
    let path = home.join(".freshell/logs/rust-server.jsonl");
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("log line is not valid JSON: {e}\nline: {line}"))
        })
        .collect()
}

fn self_check_lines(home: &Path) -> Vec<serde_json::Value> {
    log_lines(home)
        .into_iter()
        .filter(|l| l["event"].as_str() == Some("containment.self_check"))
        .collect()
}

/// Bounded wait for the first log line matching `pred`.
async fn wait_for_log_line(
    home: &Path,
    limit: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(found) = log_lines(home).into_iter().find(|l| pred(l)) {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// `(soft, hard)` from the `Max open files` row of `/proc/<pid>/limits`.
fn nofile_limits(pid: u32) -> (u64, u64) {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/limits")).expect("read limits");
    let row = raw
        .lines()
        .find(|l| l.starts_with("Max open files"))
        .expect("Max open files row");
    let cols: Vec<&str> = row.split_whitespace().collect();
    (
        cols[3].parse().expect("numeric soft limit"),
        cols[4].parse().expect("numeric hard limit"),
    )
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

async fn connect_ready(port: u16) -> WsStream {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
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
    ws
}

/// Creates a plain shell terminal and returns its terminal id and the
/// shell's pid (read from the server's `terminal.created` log line).
async fn create_shell(ws: &mut WsStream, home: &Path) -> (String, u32) {
    let request_id = format!("containment-startup-{}", uuid::Uuid::new_v4());
    send_json(
        ws,
        &serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
        }),
    )
    .await;
    let created =
        wait_for_any_message_type(ws, &["terminal.created", "error"], Duration::from_secs(15))
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

    let created_line = wait_for_log_line(home, Duration::from_secs(5), |l| {
        l["msg"].as_str() == Some("terminal.created")
            && l["terminal_id"].as_str() == Some(terminal_id.as_str())
    })
    .await
    .expect("terminal.created must be logged with the shell's pid");
    let shell_pid = created_line["pid"].as_u64().expect("terminal.created pid") as u32;
    (terminal_id, shell_pid)
}

async fn kill_terminal(ws: &mut WsStream, terminal_id: &str) {
    send_json(
        ws,
        &serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id }),
    )
    .await;
}

/// Starts the server with its soft open-file limit lowered to `soft` (the
/// hard limit is unchanged).
fn start_with_soft_nofile(cmd: &mut Command, soft: u64) {
    // SAFETY: the closure runs between fork and exec and makes only the
    // getrlimit/setrlimit system calls on a stack value.
    unsafe {
        cmd.pre_exec(move || {
            let mut lim = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            lim.rlim_cur = soft as libc::rlim_t;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// The NUL-separated `KEY=VALUE` entries of a process's environment.
fn environ_entries(pid: u32) -> Vec<String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).expect("read shell environ");
    raw.split(|b| *b == 0)
        .filter(|kv| !kv.is_empty())
        .map(|kv| String::from_utf8_lossy(kv).into_owned())
        .collect()
}

// ── tests ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_never_passes_an_inherited_unit_tag_to_its_children() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    let mut cmd = server_command(&server_binary, home.path(), port);
    // As if this server had been started from inside an agent pane.
    cmd.env("FRESHELL_UNIT_ID", INHERITED_UNIT_ID)
        .env("FRESHELL_CODEX_SIDECAR_ID", INHERITED_LEGACY_TAG);
    let mut boot = boot(cmd, port).await;

    let mut ws = connect_ready(boot.port).await;
    let (terminal_id, shell_pid) = create_shell(&mut ws, home.path()).await;
    let environ = environ_entries(shell_pid);

    // Stop the shell before asserting, so a failure leaves nothing running.
    kill_terminal(&mut ws, &terminal_id).await;
    ws.close(None).await.ok();
    sigterm_and_reap(&mut boot).await;

    assert!(
        environ.iter().any(|kv| kv == &format!("{MARKER_ENV}=1")),
        "the shell's environment must come from the server (marker missing): {environ:?}"
    );
    for key in ["FRESHELL_UNIT_ID", "FRESHELL_CODEX_SIDECAR_ID"] {
        let leaked: Vec<&String> = environ
            .iter()
            .filter(|kv| kv.starts_with(&format!("{key}=")))
            .collect();
        assert!(
            leaked.is_empty(),
            "the shell inherited the server's {key}: {leaked:?}"
        );
    }

    // The removal is logged by name only, never by value.
    let checks = self_check_lines(home.path());
    assert_eq!(checks.len(), 1, "one self-check line: {checks:?}");
    assert_eq!(
        checks[0]["removed_tags"].as_str(),
        Some("FRESHELL_UNIT_ID,FRESHELL_CODEX_SIDECAR_ID")
    );
    let raw = checks[0].to_string();
    assert!(
        !raw.contains(INHERITED_UNIT_ID) && !raw.contains(INHERITED_LEGACY_TAG),
        "tag values must never be logged: {raw}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_logs_one_containment_self_check_at_start() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    let mut boot = boot(server_command(&server_binary, home.path(), port), port).await;
    let stderr_seen = boot
        .wait_stderr_contains(
            "freshell-server: containment self-check pidfd=ok task_children=ok",
            Duration::from_secs(5),
        )
        .await;
    sigterm_and_reap(&mut boot).await;

    let checks = self_check_lines(home.path());
    assert_eq!(
        checks.len(),
        1,
        "exactly one containment.self_check line: {checks:?}"
    );
    let check = &checks[0];
    assert_eq!(check["target"].as_str(), Some("freshell_unit"));
    assert_eq!(check["level"].as_str(), Some("INFO"));
    assert_eq!(check["applicable"].as_bool(), Some(true), "{check}");
    assert_eq!(check["pidfd"].as_bool(), Some(true), "{check}");
    assert_eq!(check["task_children"].as_bool(), Some(true), "{check}");
    assert_eq!(check["detail"].as_str(), Some(""), "{check}");
    assert_eq!(check["removed_tags"].as_str(), Some(""), "{check}");
    assert!(
        stderr_seen,
        "stderr must carry the self-check summary; stderr:\n{}",
        boot.stderr_text()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_raises_its_open_file_soft_limit() {
    const LOWERED_SOFT: u64 = 256;
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    let mut cmd = server_command(&server_binary, home.path(), port);
    start_with_soft_nofile(&mut cmd, LOWERED_SOFT);
    let mut boot = boot(cmd, port).await;
    let (soft, hard) = nofile_limits(boot.child.id());
    sigterm_and_reap(&mut boot).await;

    assert!(
        hard > LOWERED_SOFT,
        "the test needs a hard limit above {LOWERED_SOFT} (got {hard})"
    );
    assert_eq!(
        soft, hard,
        "the server must raise its soft open-file limit to the hard limit"
    );
    let checks = self_check_lines(home.path());
    assert_eq!(checks.len(), 1, "one self-check line: {checks:?}");
    assert_eq!(checks[0]["nofile_soft_before"].as_u64(), Some(LOWERED_SOFT));
    assert_eq!(checks[0]["nofile_soft_after"].as_u64(), Some(hard));
    assert_eq!(checks[0]["nofile_error"].as_str(), Some(""));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_servers_children_start_with_its_original_open_file_soft_limit() {
    const LOWERED_SOFT: u64 = 256;
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    let mut cmd = server_command(&server_binary, home.path(), port);
    start_with_soft_nofile(&mut cmd, LOWERED_SOFT);
    let mut boot = boot(cmd, port).await;
    let (server_soft, hard) = nofile_limits(boot.child.id());

    // A PTY child: a plain shell pane.
    let mut ws = connect_ready(boot.port).await;
    let (terminal_id, shell_pid) = create_shell(&mut ws, home.path()).await;
    let shell_limits = nofile_limits(shell_pid);

    // An ordinary (tokio `Command`) child: the exec route runs `bash -lc`,
    // which reads its own row of `/proc/<pid>/limits`.
    let exec = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{}/api/fresh-agent/exec",
            boot.port
        ))
        .header("x-auth-token", AUTH_TOKEN)
        .json(&serde_json::json!({
            "command": "grep 'Max open files' /proc/$$/limits",
            "cwd": home.path(),
        }))
        .send()
        .await
        .expect("exec request");
    let exec_status = exec.status();
    let exec_body: serde_json::Value = exec.json().await.expect("exec answers JSON");

    // Stop the shell and the server before asserting.
    kill_terminal(&mut ws, &terminal_id).await;
    ws.close(None).await.ok();
    sigterm_and_reap(&mut boot).await;

    assert!(
        hard > LOWERED_SOFT,
        "the test needs a hard limit above {LOWERED_SOFT} (got {hard})"
    );
    assert_eq!(server_soft, hard, "the server itself runs raised");
    assert!(exec_status.is_success(), "exec: {exec_status} {exec_body}");
    let output = exec_body["output"].as_str().expect("exec output");
    let row = output
        .lines()
        .find(|l| l.starts_with("Max open files"))
        .unwrap_or_else(|| panic!("the exec child printed its limits: {exec_body}"));
    let cols: Vec<&str> = row.split_whitespace().collect();
    let exec_limits: (u64, u64) = (
        cols[3].parse().expect("numeric soft limit"),
        cols[4].parse().expect("numeric hard limit"),
    );
    assert_eq!(
        [("shell pane", shell_limits), ("exec child", exec_limits)],
        [
            ("shell pane", (LOWERED_SOFT, hard)),
            ("exec child", (LOWERED_SOFT, hard))
        ],
        "every child must start with the server's original soft limit"
    );
}
