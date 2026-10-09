//! Test-only support for the realistic Codex fake (launcher + separate native).
//! Every process these helpers signal was spawned by the calling test.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

pub fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server")
        .join(name)
        .canonicalize()
        .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

pub fn launcher_command() -> String {
    format!("node {}", fixture_path("fake-codex-launcher.mjs").display())
}

pub fn tui_command() -> String {
    format!("node {}", fixture_path("fake-codex-tui.mjs").display())
}

pub fn thread_lock_path(codex_home: &Path, id: &str) -> PathBuf {
    codex_home
        .join("thread-writer-locks")
        .join(format!("{id}.lock"))
}

/// The compiled `fake-codex-lock-holder` (`[[bin]]` of `freshell-codex`): the real
/// Codex writer lock off Linux. Looked up next to the running test executable.
pub fn lock_holder_exe() -> PathBuf {
    let name = format!("fake-codex-lock-holder{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().expect("current test executable");
    exe.ancestors()
        .skip(1)
        .take(3)
        .map(|dir| dir.join(&name))
        .find(|candidate| candidate.exists())
        .unwrap_or_else(|| panic!("fixture binary fake-codex-lock-holder not built"))
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChildPids {
    pub helper: Option<u32>,
    pub mcp: Option<u32>,
    #[serde(default)]
    pub shell: Vec<u32>,
    #[serde(default)]
    pub detached: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalEntry {
    pub sig: String,
    pub at_ms: u64,
    /// JSON text of the unit record's `state` at the moment of the signal
    /// (`FAKE_UNIT_RECORD_DIR`/`FRESHELL_UNIT_ID`), `None` when there is none.
    pub record_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeManifest {
    pub pid: u32,
    #[serde(default)]
    pub threads: Vec<String>,
    #[serde(default)]
    pub children: ChildPids,
    #[serde(default)]
    pub signals: Vec<SignalEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherManifest {
    native_pid: u32,
}

pub struct FakeAppServer {
    pub child: tokio::process::Child,
    pub port: u16,
    pub codex_home: PathBuf,
    pub manifest_dir: PathBuf,
    /// The native's (pid, start time), so `Drop` only ever kills that exact process.
    native_identity: Option<(u32, u64)>,
}

impl FakeAppServer {
    pub async fn spawn(behavior: Value, codex_home: &Path, extra_env: &[(&str, &str)]) -> Self {
        Self::spawn_on_port(unique_free_port(), behavior, codex_home, extra_env).await
    }

    pub async fn spawn_on_port(
        port: u16,
        behavior: Value,
        codex_home: &Path,
        extra_env: &[(&str, &str)],
    ) -> Self {
        let manifest_dir = codex_home.join("manifests");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(fixture_path("fake-codex-launcher.mjs"))
            .args(["app-server", "--listen", &format!("ws://127.0.0.1:{port}")])
            .env("CODEX_HOME", codex_home)
            .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
            .env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string())
            .env("FAKE_CODEX_MANIFEST_DIR", &manifest_dir)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().expect("spawn fake launcher");
        let mut me = Self {
            child,
            port,
            codex_home: codex_home.to_path_buf(),
            manifest_dir,
            native_identity: None,
        };
        wait_until("native manifest", Duration::from_secs(10), || {
            me.try_native().is_some()
        })
        .await;
        let pid = me.try_native().expect("native manifest").pid;
        me.native_identity = proc_starttime(pid).map(|start| (pid, start));
        me
    }

    pub fn launcher_pid(&self) -> u32 {
        self.child.id().expect("launcher pid")
    }

    /// Synchronous manifest read (launcher manifest -> native manifest); usable in
    /// `wait_until` predicates.
    pub fn try_native(&self) -> Option<NativeManifest> {
        let raw = std::fs::read_to_string(
            self.manifest_dir
                .join(format!("launcher-{}.json", self.child.id()?)),
        )
        .ok()?;
        let launcher: LauncherManifest = serde_json::from_str(&raw).ok()?;
        let raw = std::fs::read_to_string(
            self.manifest_dir
                .join(format!("native-{}.json", launcher.native_pid)),
        )
        .ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub async fn native(&self) -> NativeManifest {
        self.try_native().expect("native manifest present")
    }
}

impl Drop for FakeAppServer {
    /// `kill_on_drop` ends only the launcher; the native would otherwise outlive the
    /// test. Kill it only while its pid still names the process this fake started.
    fn drop(&mut self) {
        if let Some((pid, start)) = self.native_identity {
            if proc_starttime(pid) == Some(start) {
                signal_own_child(pid, libc::SIGKILL);
            }
        }
    }
}

/// A free loopback port this test process has never handed out before. The port is
/// probed with `bind(0)` and released before the native listens on it, so without the
/// de-duplication two fakes started by parallel tests could be given the same port
/// and one test's RPC would reach the other test's native.
pub fn unique_free_port() -> u16 {
    static HANDED_OUT: Mutex<BTreeSet<u16>> = Mutex::new(BTreeSet::new());
    loop {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .expect("probe a free loopback port")
            .port();
        if HANDED_OUT.lock().unwrap().insert(port) {
            return port;
        }
    }
}

/// Test-only bounded wait (product code never polls; this is harness code).
pub async fn wait_until(what: &str, limit: Duration, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn stat_fields(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &raw[raw.rfind(')')? + 2..];
    Some(after.split_whitespace().map(str::to_string).collect())
}

pub fn pid_alive(pid: u32) -> bool {
    stat_fields(pid).is_some_and(|f| f[0] != "Z" && f[0] != "X")
}

/// `/proc/<pid>/stat` field 22 (start time in clock ticks since boot).
pub fn proc_starttime(pid: u32) -> Option<u64> {
    stat_fields(pid)?.get(19)?.parse().ok()
}

pub fn proc_ids(pid: u32) -> (u32, u32, u32) {
    let f = stat_fields(pid).expect("process exists");
    (
        f[1].parse().unwrap(),
        f[2].parse().unwrap(),
        f[3].parse().unwrap(),
    )
}

pub fn environ_value(pid: u32, key: &str) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    raw.split(|b| *b == 0).find_map(|kv| {
        let s = String::from_utf8_lossy(kv);
        s.strip_prefix(&format!("{key}=")).map(str::to_string)
    })
}

/// Test-only "is anything locking this inode" (`/proc/locks`).
pub fn lock_held(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let needle = format!(":{} ", meta.ino());
    std::fs::read_to_string("/proc/locks")
        .unwrap_or_default()
        .lines()
        .any(|l| l.contains("FLOCK") && format!("{l} ").contains(&needle))
}

/// True when `pid` holds a lock on `path` through one of its own file descriptors:
/// an entry of `/proc/<pid>/fd` opens the same file and its `fdinfo` has a `lock:`
/// line. This is how Freshell attributes lock holders (never by the `/proc/locks`
/// pid column, which names whoever called `flock(2)`).
pub fn holds_lock_fd(pid: u32, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(target) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Ok(meta) = std::fs::metadata(entry.path()) else {
            return false;
        };
        meta.dev() == target.dev()
            && meta.ino() == target.ino()
            && std::fs::read_to_string(format!(
                "/proc/{pid}/fdinfo/{}",
                entry.file_name().to_string_lossy()
            ))
            .is_ok_and(|info| info.lines().any(|line| line.starts_with("lock:")))
    })
}

/// Only for pids this test spawned (launcher, native, or their children).
pub fn signal_own_child(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// The thread a notification is about: `params.threadId`, else `params.thread.id`.
pub fn notification_thread(note: &Value) -> Option<&str> {
    note["params"]["threadId"]
        .as_str()
        .or_else(|| note["params"]["thread"]["id"].as_str())
}

pub struct Rpc {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next_id: u64,
    pending_notes: Vec<Value>,
}

impl Rpc {
    pub async fn connect(port: u16) -> Rpc {
        let url = format!("ws://127.0.0.1:{port}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await {
                return Rpc {
                    ws,
                    next_id: 1,
                    pending_notes: Vec::new(),
                };
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fake app-server never listened"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn initialize(&mut self) {
        self.call(
            "initialize",
            json!({"clientInfo": {"name": "t", "version": "1"},
            "capabilities": {"experimentalApi": true}}),
        )
        .await
        .expect("initialize");
        self.ws
            .send(Message::Text(
                json!({"jsonrpc":"2.0","method":"initialized"}).to_string(),
            ))
            .await
            .unwrap();
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.ws
            .send(Message::Text(
                json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
            ))
            .await
            .unwrap();
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(20), self.ws.next())
                .await
                .expect("rpc answer in time")
                .expect("socket open")
                .expect("frame");
            let Message::Text(text) = msg else { continue };
            let v: Value = serde_json::from_str(&text).unwrap();
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                return match v.get("error") {
                    Some(err) => Err(err.clone()),
                    None => Ok(v["result"].clone()),
                };
            }
            if v.get("method").is_some() {
                self.pending_notes.push(v);
            }
        }
    }

    pub async fn next_notification(&mut self, method: &str, limit: Duration) -> Option<Value> {
        if let Some(i) = self
            .pending_notes
            .iter()
            .position(|n| n["method"] == method)
        {
            return Some(self.pending_notes.remove(i));
        }
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
            let msg = tokio::time::timeout(remaining, self.ws.next())
                .await
                .ok()??
                .ok()?;
            let Message::Text(text) = msg else { continue };
            let v: Value = serde_json::from_str(&text).ok()?;
            if v["method"] == method {
                return Some(v);
            }
            if v.get("method").is_some() {
                self.pending_notes.push(v);
            }
        }
    }

    /// The next `method` notification about `thread` (see [`notification_thread`]).
    /// Notifications of the same method about other threads are consumed and dropped.
    pub async fn next_notification_for(
        &mut self,
        method: &str,
        thread: &str,
        limit: Duration,
    ) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .unwrap_or_default();
            let note = self.next_notification(method, remaining).await?;
            if notification_thread(&note) == Some(thread) {
                return Some(note);
            }
        }
    }
}

/// The fake Codex TUI (`fake-codex-tui.mjs --remote <url>`) with piped stdin/stdout;
/// every stdout byte is kept so tests can wait for lines and count BEL bytes.
pub struct FakeTui {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    output: Arc<Mutex<Vec<u8>>>,
    changed: Arc<Notify>,
}

impl FakeTui {
    pub async fn spawn(remote: &str, extra_args: &[&str], env: &[(&str, &str)]) -> FakeTui {
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(fixture_path("fake-codex-tui.mjs"))
            .arg("--remote")
            .arg(remote)
            .args(extra_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn fake TUI");
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().expect("fake TUI stdout");
        let output = Arc::new(Mutex::new(Vec::new()));
        let changed = Arc::new(Notify::new());
        let (sink, notify) = (output.clone(), changed.clone());
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        sink.lock().unwrap().extend_from_slice(&buf[..n]);
                        notify.notify_waiters();
                    }
                }
            }
            notify.notify_waiters();
        });
        FakeTui {
            child,
            stdin,
            output,
            changed,
        }
    }

    /// Types `line` followed by Enter (`\r`).
    pub async fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("fake TUI stdin open");
        stdin
            .write_all(format!("{line}\r").as_bytes())
            .await
            .expect("write fake TUI stdin");
        stdin.flush().await.expect("flush fake TUI stdin");
    }

    /// Everything the TUI printed so far (lossy UTF-8), for assertions and diagnostics.
    pub fn output(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }

    pub fn bel_count(&self) -> usize {
        self.output
            .lock()
            .unwrap()
            .iter()
            .filter(|b| **b == 0x07)
            .count()
    }

    /// Test-only bounded wait for `needle` in the output.
    pub async fn wait_output(&mut self, needle: &str, limit: Duration) -> bool {
        self.wait_output_count(needle, 1, limit).await
    }

    /// Test-only bounded wait until `needle` has appeared at least `count` times.
    pub async fn wait_output_count(&mut self, needle: &str, count: usize, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let changed = self.changed.notified();
            if self.output().matches(needle).count() >= count {
                return true;
            }
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                return false;
            };
            if tokio::time::timeout(remaining, changed).await.is_err() {
                return self.output().matches(needle).count() >= count;
            }
        }
    }

    pub async fn wait_exit(&mut self, limit: Duration) -> Option<std::process::ExitStatus> {
        tokio::time::timeout(limit, self.child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}
