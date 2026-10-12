#![cfg(all(feature = "real-transport", target_os = "linux"))]
//! The realistic Codex fake must reproduce the process and lock facts the
//! lifecycle work depends on (design §3). Every signalled pid was spawned here.

#[path = "support/fake_codex.rs"]
mod fake_codex;
#[path = "support/lost_port.rs"]
mod lost_port;

use std::path::Path;
use std::time::{Duration, Instant};

use fake_codex::*;
use serde_json::{json, Value};

const SIGHUP: i32 = 1;
const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

async fn start_turn(rpc: &mut Rpc, thread: &str) {
    rpc.call(
        "turn/start",
        json!({"threadId": thread, "input": [{"type":"text","text":"go"}]}),
    )
    .await
    .expect("turn/start");
}

async fn connected(port: u16) -> Rpc {
    let mut rpc = Rpc::connect(port).await;
    rpc.initialize().await;
    rpc
}

fn status_type(note: &Value) -> &str {
    note["params"]["status"]["type"]
        .as_str()
        .unwrap_or_default()
}

/// The pid column of the `/proc/locks` row of the lock held on `path`, reading
/// the file again until that row appears; the test fails after 5 s without it.
///
/// No single read of the whole file is consistent: the kernel serves it one
/// page per `read()` call, however large the buffer, and a lock released
/// between two calls can make a read skip a held lock's row (see
/// [`flock_rows_once`]). Reading again is reliable for a lock that stays held
/// throughout, as here:
/// - a read never shows a row that was not there, so a row found is the lock;
/// - a read misses the row only when another lock, earlier in the list, is
///   released in the gap between two of that read's few `read()` calls, so the
///   first read that no such release disturbs finds it. A false failure would
///   need every one of about 250 reads, spread over 5 s, to be disturbed.
/// - when no lock is held, no read shows the row, and the test fails.
async fn locks_row_pid(path: &Path) -> u32 {
    wait_for_state(
        "a /proc/locks row for the held lock",
        Duration::from_secs(5),
        || {
            let rows = flock_rows_once(path);
            rows.iter()
                // A holder row reads `id: FLOCK ADVISORY WRITE pid maj:min:ino ..`
                // (a waiter's, `id: -> FLOCK ..`).
                .find_map(|row| match row.split_whitespace().collect::<Vec<_>>()[..] {
                    [_, "FLOCK", _, _, pid, ..] => pid.parse().ok(),
                    _ => None,
                })
                .ok_or_else(|| format!("no holder row in this read: {rows:?}"))
        },
    )
    .await
}

/// How a directly run launcher ended (see [`launcher_exit`]).
struct LauncherRun {
    /// `None` when it was still running after 5 s.
    code: Option<i32>,
    stderr: String,
    /// The native's last manifest, when it wrote one.
    native: Option<NativeManifest>,
}

/// Runs the launcher directly (stderr captured) under a throwaway `HOME`, with
/// `CODEX_HOME` set only when given, and waits up to 5 s for it to exit. A launcher
/// still running then is reported with no exit code, and its native and every
/// process the native pinned are killed.
async fn launcher_exit(behavior: Value, home: &Path, codex_home: Option<&str>) -> LauncherRun {
    let listen = format!("ws://127.0.0.1:{}", unique_free_port());
    launcher_exit_listening_on(&listen, behavior, home, codex_home).await
}

/// [`launcher_exit`] with the fake told to listen on `listen`.
async fn launcher_exit_listening_on(
    listen: &str,
    behavior: Value,
    home: &Path,
    codex_home: Option<&str>,
) -> LauncherRun {
    launcher_exit_with_env(listen, behavior, home, codex_home, &[]).await
}

/// [`launcher_exit_listening_on`] with `extra_env` in the launcher's
/// environment (and so in its native's).
async fn launcher_exit_with_env(
    listen: &str,
    behavior: Value,
    home: &Path,
    codex_home: Option<&str>,
    extra_env: &[(&str, &str)],
) -> LauncherRun {
    use tokio::io::AsyncReadExt;
    let manifest_dir = home.join("manifests");
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(fixture_path("fake-codex-launcher.mjs"))
        .args(["app-server", "--listen", listen])
        // Never the developer's home, even if the fake falls back to `~/.codex`.
        .env("HOME", home)
        .env_remove("CODEX_HOME")
        .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
        .env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string())
        .env("FAKE_CODEX_MANIFEST_DIR", &manifest_dir)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(codex_home) = codex_home {
        cmd.env("CODEX_HOME", codex_home);
    }
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().expect("spawn fake launcher");
    let launcher = child.id().expect("launcher pid");
    let mut stderr = child.stderr.take().expect("launcher stderr");
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => LauncherRun {
            code: status.expect("wait for the launcher").code(),
            stderr: stderr.await.expect("stderr reader"),
            native: read_native_manifest(&manifest_dir, launcher),
        },
        Err(_) => {
            let native = read_native_manifest(&manifest_dir, launcher);
            if let Some(native) = &native {
                native.kill_all();
            }
            LauncherRun {
                code: None,
                stderr: String::new(),
                native,
            }
        }
    }
}

/// Writes `id`'s rollout under `<codex_home>/sessions/`, as Codex does at a
/// conversation's first turn: the fake (like Codex) resumes only a thread
/// that has one.
fn seed_rollout(codex_home: &Path, id: &str) {
    let sessions = codex_home.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let meta = json!({"type": "session_meta", "payload": {"id": id, "cwd": "/"}});
    std::fs::write(
        sessions.join(format!("rollout-{id}.jsonl")),
        format!("{meta}\n"),
    )
    .unwrap();
}

/// Whether any rollout file under `<codex_home>/sessions/` names `id`.
fn rollout_exists(codex_home: &Path, id: &str) -> bool {
    fn walk(dir: &Path, id: &str) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        entries.flatten().any(|e| {
            let path = e.path();
            if path.is_dir() {
                walk(&path, id)
            } else {
                e.file_name().to_string_lossy() == format!("rollout-{id}.jsonl")
            }
        })
    }
    walk(&codex_home.join("sessions"), id)
}

#[tokio::test(flavor = "multi_thread")]
async fn launcher_spawns_a_separate_native_that_owns_the_listener() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let native = fake.native().await;
    assert_ne!(native.pid, fake.launcher_pid());
    let (ppid, pgid, _sid) = proc_ids(native.pid);
    assert_eq!(ppid, fake.launcher_pid(), "native is the launcher's child");
    assert_eq!(
        pgid,
        proc_ids(fake.launcher_pid()).1,
        "launcher and native share a group"
    );
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
}

/// A native whose port another socket holds exits with its own status, 98,
/// writes one stderr line and records why in its manifest, never claiming to
/// listen (whoever chose the port retries on a new one). Any other listen
/// error still fails the start as an uncaught error (status 1).
#[tokio::test(flavor = "multi_thread")]
async fn a_native_whose_port_is_taken_exits_98_and_says_why() {
    let home = tempfile::tempdir().unwrap();
    let codex_home = home.path().to_str().unwrap();
    let holder = std::net::TcpListener::bind("127.0.0.1:0").expect("hold a loopback port");
    let taken = holder.local_addr().expect("the held port").port();
    let run = launcher_exit_listening_on(
        &format!("ws://127.0.0.1:{taken}"),
        json!({}),
        home.path(),
        Some(codex_home),
    )
    .await;
    assert_eq!(run.code, Some(98), "{}", run.stderr);
    assert_eq!(
        run.stderr
            .lines()
            .filter(|line| line.starts_with(&format!(
                "fake-app-server: listen 127.0.0.1:{taken} failed: EADDRINUSE"
            )))
            .count(),
        1,
        "{}",
        run.stderr
    );
    let native = run.native.expect("the native's manifest");
    assert_eq!(native.listen_error.as_deref(), Some("EADDRINUSE"));
    assert!(!native.listening, "it never claims to listen");
    drop(holder);

    // 192.0.2.1 (a documentation address) is on no interface: EADDRNOTAVAIL.
    let other = tempfile::tempdir().unwrap();
    let run = launcher_exit_listening_on(
        &format!("ws://192.0.2.1:{}", unique_free_port()),
        json!({}),
        other.path(),
        Some(other.path().to_str().unwrap()),
    )
    .await;
    assert_eq!(run.code, Some(1), "{}", run.stderr);
    assert!(run.stderr.contains("EADDRNOTAVAIL"), "{}", run.stderr);
    let native = run.native.expect("the native's manifest");
    assert_eq!(native.listen_error, None, "only a taken port is recorded");
    assert!(!native.listening);

    let fake = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    assert!(
        fake.native().await.listening,
        "a native that listens says so"
    );
}

/// The listen records (`listen-<pid>.json` under `dir`), by pid.
fn listen_records(dir: &Path) -> std::collections::BTreeMap<u64, Value> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("listen-") && name.ends_with(".json"))
        })
        .map(|entry| {
            let record: Value =
                serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
            (
                record["pid"].as_u64().expect("the record names its pid"),
                record,
            )
        })
        .collect()
}

/// Every fake, single-process or native, records under
/// `FAKE_CODEX_LISTEN_RECORD_DIR` whether it listened or lost its port,
/// before it answers anyone or exits: whoever started it learns how its own
/// start went even when another app-server answers on the port.
#[tokio::test(flavor = "multi_thread")]
async fn every_fake_records_whether_it_listened_or_lost_its_port() {
    let home = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    let record_env = [(
        lost_port::LISTEN_RECORD_DIR_ENV,
        records.path().to_str().unwrap(),
    )];
    let holder = std::net::TcpListener::bind("127.0.0.1:0").expect("hold a loopback port");
    let taken = holder.local_addr().expect("the held port").port();
    let single = || {
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(fixture_path("fake-app-server.mjs"))
            .env("CODEX_HOME", home.path())
            .env(record_env[0].0, record_env[0].1)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        cmd
    };

    // The single-process fake on the taken port.
    let mut lost = single()
        .args(["--listen", &format!("ws://127.0.0.1:{taken}")])
        .spawn()
        .expect("spawn the single-process fake");
    let lost_pid = u64::from(lost.id().expect("its pid"));
    let status = tokio::time::timeout(Duration::from_secs(10), lost.wait())
        .await
        .expect("it exits")
        .expect("wait for it");
    assert_eq!(status.code(), Some(98));
    assert_eq!(
        listen_records(records.path())[&lost_pid],
        json!({"pid": lost_pid, "port": taken, "listenError": "EADDRINUSE"})
    );

    // The single-process fake that listens. It writes its record before its
    // port file, and the native before its manifest's mark (see the next
    // test), so neither read below waits.
    let (_listening, port) = lost_port::spawn_on_its_own_port(single()).await;
    let pid = listen_records(records.path())
        .into_iter()
        .find_map(|(pid, record)| (record["listening"] == true).then_some(pid))
        .expect("its record");
    assert_eq!(
        listen_records(records.path())[&pid],
        json!({"pid": pid, "port": port, "listening": true})
    );

    // The native behind the launcher, on the taken port and then listening.
    let mut native_lost =
        FakeAppServer::spawn_on_port(taken, json!({}), home.path(), &record_env).await;
    let lost_native = u64::from(native_lost.native().await.pid);
    let exit = native_lost
        .listened()
        .await
        .expect_err("the native loses the port");
    assert!(exit.contains("exit status: 98"), "{exit}");
    assert_eq!(
        listen_records(records.path())[&lost_native]["listenError"],
        "EADDRINUSE"
    );
    let native = FakeAppServer::spawn(json!({}), home.path(), &record_env).await;
    let listening_native = u64::from(native.native().await.pid);
    assert_eq!(
        listen_records(records.path())[&listening_native],
        json!({"pid": listening_native, "port": native.port, "listening": true})
    );
    drop(holder);
}

/// A fake that listens writes its listen record first, then its port file
/// (port-file mode), then its manifest's `listening` mark (the native), all
/// before it answers anyone. So whoever sees the port file or the mark finds
/// the record, and whoever sees the mark finds the port file
/// ([`FakeAppServer::listened`], [`lost_port::spawn_on_its_own_port`] and the
/// test above read them in that order). Each write is made to fail in turn:
/// the fake dies at that write, and none of the later ones exists.
#[tokio::test(flavor = "multi_thread")]
async fn a_listening_fake_writes_its_record_then_its_port_file_then_its_mark() {
    // The record cannot be written: its directory would be under a file.
    let home = tempfile::tempdir().unwrap();
    let not_a_directory = home.path().join("not-a-directory");
    std::fs::write(&not_a_directory, "").unwrap();
    let record_dir = not_a_directory.join("records");
    let port_file = home.path().join("port");
    let run = launcher_exit_with_env(
        "ws://127.0.0.1:0",
        json!({}),
        home.path(),
        Some(home.path().to_str().unwrap()),
        &[
            (
                lost_port::LISTEN_RECORD_DIR_ENV,
                record_dir.to_str().unwrap(),
            ),
            (lost_port::PORT_FILE_ENV, port_file.to_str().unwrap()),
        ],
    )
    .await;
    assert_eq!(run.code, Some(1), "{}", run.stderr);
    assert!(
        run.stderr.contains("ENOTDIR") && run.stderr.contains(record_dir.to_str().unwrap()),
        "it dies writing its record: {}",
        run.stderr
    );
    assert!(!port_file.exists(), "no port file before the record");
    assert!(
        !run.native.expect("the native's manifest").listening,
        "no listening mark before the record"
    );

    // The record is written; the port file cannot be: its directory is missing.
    let home = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    let port_file = home.path().join("missing").join("port");
    let run = launcher_exit_with_env(
        "ws://127.0.0.1:0",
        json!({}),
        home.path(),
        Some(home.path().to_str().unwrap()),
        &[
            (
                lost_port::LISTEN_RECORD_DIR_ENV,
                records.path().to_str().unwrap(),
            ),
            (lost_port::PORT_FILE_ENV, port_file.to_str().unwrap()),
        ],
    )
    .await;
    assert_eq!(run.code, Some(1), "{}", run.stderr);
    assert!(
        run.stderr.contains("ENOENT") && run.stderr.contains(port_file.to_str().unwrap()),
        "it dies writing its port file: {}",
        run.stderr
    );
    let native = run.native.expect("the native's manifest");
    let record = &listen_records(records.path())[&u64::from(native.pid)];
    assert_eq!(record["listening"], true, "the record before the port file");
    assert_ne!(record["port"], 0, "the port the kernel gave it: {record}");
    assert!(!native.listening, "no listening mark before the port file");
}

#[tokio::test(flavor = "multi_thread")]
async fn launcher_forwards_only_the_first_signal() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 3000, "threadStartThreadId": "t-fwd"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-fwd").await;
    assert!(fake.signal_launcher(SIGTERM));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(fake.signal_launcher(SIGINT));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let native = fake.native().await;
    let sigs: Vec<_> = native.signals.iter().map(|s| s.sig.as_str()).collect();
    assert_eq!(
        sigs,
        vec!["SIGTERM"],
        "the second signal never reaches the native"
    );
    assert!(
        pid_alive(native.pid),
        "a draining native keeps running its turn"
    );
    assert!(fake.signal_native(SIGKILL));
}

#[tokio::test(flavor = "multi_thread")]
async fn sigterm_drains_the_running_turn_before_exit() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 1500, "threadStartThreadId": "t-drain"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-drain").await;
    let native = fake.native().await.pid;
    let t0 = Instant::now();
    assert!(fake.signal_native(SIGTERM));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(pid_alive(native), "SIGTERM must not stop a running turn");
    let done = rpc
        .next_notification("turn/completed", Duration::from_secs(5))
        .await
        .expect("turn completes");
    assert_eq!(done["params"]["turn"]["status"], "completed");
    wait_until("native exit after drain", Duration::from_secs(3), || {
        !pid_alive(native)
    })
    .await;
    assert!(t0.elapsed() >= Duration::from_millis(1400));
}

#[tokio::test(flavor = "multi_thread")]
async fn sigint_stops_at_once() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 60000, "threadStartThreadId": "t-int"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-int").await;
    let native = fake.native().await.pid;
    let t0 = Instant::now();
    assert!(fake.signal_native(SIGINT));
    wait_until("native exit after SIGINT", Duration::from_secs(2), || {
        !pid_alive(native)
    })
    .await;
    assert!(t0.elapsed() < Duration::from_millis(1000));
}

#[tokio::test(flavor = "multi_thread")]
async fn sigint_reports_the_running_turn_completed() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 60000, "threadStartThreadId": "t-sigint"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = connected(fake.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-sigint").await;
    let native = fake.native().await.pid;
    assert!(fake.signal_native(SIGINT));
    let done = rpc
        .next_notification_for("turn/completed", "t-sigint", Duration::from_secs(1))
        .await
        .expect("the SIGINT-ended turn is reported before the native exits");
    assert_eq!(
        done["params"]["turn"]["status"], "completed",
        "Codex 0.162 reports a SIGINT-ended turn as completed"
    );
    wait_until("native exit after SIGINT", Duration::from_secs(1), || {
        !pid_alive(native)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn descendants_have_the_realistic_topology() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"spawnHelperProcess": true, "mcpChild": true, "turnSpawnsShellCommand": true,
               "detachedJobOnTurn": true, "turnCompleteDelayMs": 60000, "threadStartThreadId": "t-topo"}),
        home.path(),
        &[("FRESHELL_UNIT_ID", "uabc")],
    )
    .await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-topo").await;
    wait_until("turn descendants", Duration::from_secs(5), || {
        fake.try_native()
            .is_some_and(|m| !m.children.shell.is_empty() && !m.children.detached.is_empty())
    })
    .await;
    let m = fake.native().await;
    let (_, native_pgid, native_sid) = proc_ids(m.pid);
    let helper = m.children.helper.expect("helper");
    let (_, hp, hs) = proc_ids(helper);
    assert_eq!(hp, helper, "helper leads its own process group");
    assert_eq!(hs, native_sid, "helper stays in the native's session");
    assert_ne!(hp, native_pgid);
    let shell = m.children.shell[0];
    assert_eq!(
        proc_ids(shell).2,
        shell,
        "shell command leads its own session"
    );
    let detached = m.children.detached[0];
    assert_ne!(
        proc_ids(detached).0,
        m.pid,
        "detached job is reparented away from the native"
    );
    for pid in [m.pid, helper, shell, detached] {
        assert_eq!(
            environ_value(pid, "FRESHELL_UNIT_ID").as_deref(),
            Some("uabc")
        );
    }
    for pid in [detached, shell, helper, m.pid] {
        assert!(m.signal(pid, SIGKILL));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn flock_refuses_a_second_writer_and_releases_on_native_exit() {
    let home = tempfile::tempdir().unwrap();
    let a = FakeAppServer::spawn(json!({"threadStartThreadId": "t-lock"}), home.path(), &[]).await;
    let mut rpc_a = Rpc::connect(a.port).await;
    rpc_a.initialize().await;
    rpc_a.call("thread/start", json!({})).await.unwrap();
    let lock = thread_lock_path(home.path(), "t-lock");
    assert!(
        holds_lock_fd(a.native().await.pid, &lock),
        "native A holds the thread lock"
    );
    // t-lock had a turn (its rollout is on disk), so only the lock refuses.
    seed_rollout(home.path(), "t-lock");
    let b = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut rpc_b = Rpc::connect(b.port).await;
    rpc_b.initialize().await;
    let refused = rpc_b
        .call("thread/resume", json!({"threadId": "t-lock"}))
        .await
        .expect_err("conflict");
    assert!(refused["message"]
        .as_str()
        .unwrap()
        .contains("thread t-lock already has an active writer"));
    assert!(a.signal_native(SIGKILL));
    wait_until("lock release", Duration::from_secs(2), || !lock_held(&lock)).await;
    rpc_b
        .call("thread/resume", json!({"threadId": "t-lock"}))
        .await
        .expect("resume after release");
    assert!(b.signal_native(SIGKILL));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lock_lives_on_the_natives_own_file_descriptor() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({"threadStartThreadId": "t-fd"}), home.path(), &[]).await;
    let mut rpc = connected(fake.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    let lock = thread_lock_path(home.path(), "t-fd");
    let native = fake.native().await.pid;
    assert!(
        holds_lock_fd(native, &lock),
        "the native's own fd carries the lock"
    );
    assert!(
        !holds_lock_fd(fake.launcher_pid(), &lock),
        "the launcher holds no lock"
    );
    let row_pid = locks_row_pid(&lock).await;
    assert_ne!(
        row_pid, native,
        "the /proc/locks pid column names the exited flock(1), never the holder"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn queue_goal_and_helper_threads_are_reported() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-root", "turnCompleteDelayMs": 60000,
               "helperThreadOnTurn": {"id": "t-helper", "durationMs": 60000},
               "queuedSubmissions": {"t-root": 2}, "goals": {"t-root": {"status": "active"}},
               "preloadedThreads": ["t-earlier"]}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-root").await;
    let status = rpc
        .next_notification("thread/status/changed", Duration::from_secs(5))
        .await;
    assert!(status.is_some());
    let loaded = rpc.call("thread/loaded/list", json!({})).await.unwrap();
    let ids: Vec<_> = loaded["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let native = fake.native().await.pid;
    for id in ["t-root", "t-helper", "t-earlier"] {
        assert!(ids.contains(&id.to_string()), "{id} loaded");
        assert!(
            holds_lock_fd(native, &thread_lock_path(home.path(), id)),
            "{id} locked"
        );
    }
    let helper = rpc
        .call("thread/read", json!({"threadId": "t-helper"}))
        .await
        .unwrap();
    assert_eq!(helper["thread"]["status"]["type"], "active");
    let q = rpc
        .call("thread/queue/list", json!({"threadId": "t-root"}))
        .await
        .unwrap();
    assert_eq!(q["data"].as_array().unwrap().len(), 2);
    let g = rpc
        .call("thread/goal/get", json!({"threadId": "t-root"}))
        .await
        .unwrap();
    assert_eq!(g["goal"]["status"], "active");
    assert!(fake.signal_native(SIGKILL));
}

#[tokio::test(flavor = "multi_thread")]
async fn thread_loads_are_announced_like_codex() {
    let home = tempfile::tempdir().unwrap();
    // (1) A helper spawn: status idle then active plus the parent's spawn item; no
    // thread/started.
    let first = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-root",
               "helperThreadOnTurn": {"id": "t-helper", "durationMs": 300}}),
        home.path(),
        &[],
    )
    .await;
    let mut a = connected(first.port).await;
    let mut b = connected(first.port).await;
    b.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut b, "t-root").await;
    let limit = Duration::from_secs(5);
    let s1 = a
        .next_notification_for("thread/status/changed", "t-helper", limit)
        .await
        .expect("helper status");
    assert_eq!(status_type(&s1), "idle", "{s1}");
    let s2 = a
        .next_notification_for("thread/status/changed", "t-helper", limit)
        .await
        .expect("helper status");
    assert_eq!(status_type(&s2), "active", "{s2}");
    let spawn_item = a
        .next_notification_for("item/completed", "t-root", limit)
        .await
        .expect("the parent's spawn item");
    let item = &spawn_item["params"]["item"];
    assert_eq!(item["type"], "collabAgentToolCall");
    assert_eq!(item["tool"], "spawnAgent");
    assert_eq!(item["receiverThreadIds"], json!(["t-helper"]));
    assert!(
        a.next_notification_for("thread/started", "t-helper", Duration::from_millis(500))
            .await
            .is_none(),
        "a helper spawn is never announced with thread/started"
    );

    // (2) A cold resume on a second native: status notLoaded then idle; no thread/started.
    assert!(first.signal_native(SIGKILL));
    wait_until(
        "first native's locks released",
        Duration::from_secs(2),
        || !lock_held(&thread_lock_path(home.path(), "t-root")),
    )
    .await;
    let second = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut a2 = connected(second.port).await;
    let mut resumer = connected(second.port).await;
    resumer
        .call("thread/resume", json!({"threadId": "t-root"}))
        .await
        .expect("cold resume");
    let r1 = a2
        .next_notification_for("thread/status/changed", "t-root", limit)
        .await
        .expect("cold-resume status");
    assert_eq!(status_type(&r1), "notLoaded", "{r1}");
    let r2 = a2
        .next_notification_for("thread/status/changed", "t-root", limit)
        .await
        .expect("cold-resume status");
    assert_eq!(status_type(&r2), "idle", "{r2}");
    assert!(
        a2.next_notification_for("thread/started", "t-root", Duration::from_millis(500))
            .await
            .is_none(),
        "a resume is never announced with thread/started"
    );

    // (3) A fork is announced with thread/started naming its parent.
    let mut b2 = connected(second.port).await;
    let forked = b2
        .call("thread/fork", json!({"threadId": "t-root"}))
        .await
        .expect("fork");
    let child = forked["thread"]["id"]
        .as_str()
        .expect("fork child id")
        .to_string();
    let started = a2
        .next_notification_for("thread/started", &child, limit)
        .await
        .expect("fork announced");
    assert_eq!(started["params"]["thread"]["forkedFromId"], "t-root");
    assert!(
        holds_lock_fd(
            second.native().await.pid,
            &thread_lock_path(home.path(), &child)
        ),
        "the native holds the fork's lock too"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn helper_turn_events_reach_only_connections_open_at_spawn() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-hr",
               "helperThreadOnTurn": {"id": "t-h", "durationMs": 800}}),
        home.path(),
        &[],
    )
    .await;
    let mut a = connected(fake.port).await;
    a.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut a, "t-hr").await;
    a.next_notification_for("turn/started", "t-h", Duration::from_secs(5))
        .await
        .expect("A sees the helper's turn start");
    let mut b = connected(fake.port).await;
    let done = a
        .next_notification_for("turn/completed", "t-h", Duration::from_secs(5))
        .await
        .expect("A sees the helper's turn end");
    assert_eq!(done["params"]["turn"]["status"], "completed");
    let idle = b
        .next_notification_for("thread/status/changed", "t-h", Duration::from_secs(5))
        .await
        .expect("B sees the helper's status");
    assert_eq!(status_type(&idle), "idle", "{idle}");
    assert!(
        b.next_notification_for("turn/completed", "t-h", Duration::from_secs(2))
            .await
            .is_none(),
        "helper turn events go only to connections open at its spawn"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unloads_are_announced_and_release_the_lock() {
    // (1) The last subscriber leaves: after the unload delay the lock is released and
    // the file deleted, then notLoaded and thread/closed are broadcast. Each release is
    // proved through a probe opened while the lock was held: a check by path finds
    // nothing once the file is deleted.
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-u", "threadUnloadDelayMs": 300}),
        home.path(),
        &[],
    )
    .await;
    let mut observer = connected(fake.port).await;
    let mut driver = connected(fake.port).await;
    driver.call("thread/start", json!({})).await.unwrap();
    let lock = thread_lock_path(home.path(), "t-u");
    assert!(
        holds_lock_fd(fake.native().await.pid, &lock),
        "t-u is locked while loaded"
    );
    let probe = LockProbe::open(&lock);
    assert!(probe.held_elsewhere(), "the probe meets t-u's held lock");
    driver
        .call("thread/unsubscribe", json!({"threadId": "t-u"}))
        .await
        .expect("unsubscribe");
    observer
        .next_notification_for("thread/closed", "t-u", Duration::from_secs(2))
        .await
        .expect("t-u closed");
    let not_loaded = observer
        .next_notification_for("thread/status/changed", "t-u", Duration::ZERO)
        .await
        .expect("notLoaded arrived before thread/closed");
    assert_eq!(status_type(&not_loaded), "notLoaded", "{not_loaded}");
    assert!(!lock.exists(), "an unloaded thread's lock file is deleted");
    assert!(
        !probe.held_elsewhere(),
        "an unloaded thread's lock is released"
    );
    let loaded = observer
        .call("thread/loaded/list", json!({}))
        .await
        .unwrap();
    assert!(!loaded["data"].as_array().unwrap().contains(&json!("t-u")));

    // (2) A helper closed by its parent: interrupted turn, notLoaded, lock released,
    // no thread/closed. The parent closes it 1 s after the spawn, so the probe is
    // opened, and the lock seen held, well before the close.
    let home2 = tempfile::tempdir().unwrap();
    let closing = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-cr", "threadUnloadDelayMs": 300,
               "helperThreadOnTurn": {"id": "t-c", "durationMs": 60000, "closeAfterMs": 1000}}),
        home2.path(),
        &[],
    )
    .await;
    let mut observer2 = connected(closing.port).await;
    let mut driver2 = connected(closing.port).await;
    driver2.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut driver2, "t-cr").await;
    // The fake takes a helper's lock before it announces the helper.
    observer2
        .next_notification_for("thread/status/changed", "t-c", Duration::from_secs(5))
        .await
        .expect("the helper is announced");
    let helper_lock = thread_lock_path(home2.path(), "t-c");
    assert!(
        holds_lock_fd(closing.native().await.pid, &helper_lock),
        "the native holds the helper's lock while it runs"
    );
    let helper_probe = LockProbe::open(&helper_lock);
    assert!(
        helper_probe.held_elsewhere(),
        "the probe meets the helper's held lock"
    );
    let ended = observer2
        .next_notification_for("turn/completed", "t-c", Duration::from_secs(5))
        .await
        .expect("the closed helper's turn ends");
    assert_eq!(ended["params"]["turn"]["status"], "interrupted");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let note = observer2
            .next_notification_for("thread/status/changed", "t-c", remaining)
            .await
            .expect("the closed helper reports notLoaded");
        if status_type(&note) == "notLoaded" {
            break;
        }
    }
    assert!(
        !helper_probe.held_elsewhere(),
        "a closed helper's lock is released"
    );
    assert!(
        observer2
            .next_notification_for("thread/closed", "t-c", Duration::from_secs(1))
            .await
            .is_none(),
        "a helper closed by its parent gets no thread/closed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ephemeral_title_threads_have_no_lock_and_refuse_queue_and_goal() {
    // (1) Over RPC.
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({"threadUnloadDelayMs": 300}), home.path(), &[]).await;
    let mut rpc = connected(fake.port).await;
    let started = rpc
        .call("thread/start", json!({"ephemeral": true}))
        .await
        .expect("ephemeral start");
    let id = started["thread"]["id"]
        .as_str()
        .expect("ephemeral id")
        .to_string();
    let announced = rpc
        .next_notification_for("thread/started", &id, Duration::from_secs(5))
        .await
        .expect("ephemeral start announced");
    assert_eq!(announced["params"]["thread"]["ephemeral"], true);
    let loaded = rpc.call("thread/loaded/list", json!({})).await.unwrap();
    assert!(loaded["data"].as_array().unwrap().contains(&json!(id)));
    assert!(
        !thread_lock_path(home.path(), &id).exists(),
        "an ephemeral thread takes no lock"
    );
    let queue = rpc
        .call("thread/queue/list", json!({"threadId": id}))
        .await
        .expect_err("ephemeral queue refused");
    assert_eq!(queue["code"], -32600);
    assert_eq!(
        queue["message"],
        format!("ephemeral thread does not support queued submissions: {id}")
    );
    let goal = rpc
        .call("thread/goal/get", json!({"threadId": id}))
        .await
        .expect_err("ephemeral goal refused");
    assert_eq!(goal["code"], -32600);
    assert_eq!(
        goal["message"],
        format!("ephemeral thread does not support goals: {id}")
    );
    start_turn(&mut rpc, &id).await;
    rpc.next_notification_for("turn/completed", &id, Duration::from_secs(1))
        .await
        .expect("an ephemeral turn completes within 1 s");
    assert!(
        !rollout_exists(home.path(), &id),
        "an ephemeral turn writes no rollout"
    );

    // (2) The TUI's per-turn title thread.
    let mut observer = connected(fake.port).await;
    let mut tui = FakeTui::spawn(&format!("ws://127.0.0.1:{}", fake.port), &[], &[]).await;
    assert!(
        tui.wait_output("FAKE_TUI_READY", Duration::from_secs(10))
            .await,
        "{}",
        tui.output()
    );
    tui.send("turn hello").await;
    let deadline = Instant::now() + Duration::from_secs(5);
    let title = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let note = observer
            .next_notification("thread/started", remaining)
            .await
            .expect("the title thread is announced");
        if note["params"]["thread"]["ephemeral"] == true {
            break note["params"]["thread"]["id"].as_str().unwrap().to_string();
        }
    };
    observer
        .next_notification_for("thread/closed", &title, Duration::from_secs(5))
        .await
        .expect("the title thread unloads after its turn");
    // Every status for the title thread arrived before its thread/closed; the last of
    // them must be notLoaded.
    let mut last = None;
    while let Some(next) = observer
        .next_notification_for("thread/status/changed", &title, Duration::ZERO)
        .await
    {
        last = Some(next);
    }
    let last = last.expect("status changes for the title thread");
    assert_eq!(status_type(&last), "notLoaded", "{last}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_never_materialized_thread_cannot_be_resumed() {
    let home = tempfile::tempdir().unwrap();
    // A loads t-old before it has a rollout (opting out of the check).
    let a = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-new", "turnCompleteDelayMs": 50,
               "resumeNeedsRollout": false}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc_a = connected(a.port).await;
    rpc_a.call("thread/start", json!({})).await.unwrap();
    rpc_a
        .call("thread/resume", json!({"threadId": "t-old"}))
        .await
        .expect("t-old loads on A");
    start_turn(&mut rpc_a, "t-old").await;
    rpc_a
        .next_notification_for("turn/completed", "t-old", Duration::from_secs(5))
        .await
        .expect("t-old's turn completes");
    assert!(
        rollout_exists(home.path(), "t-old"),
        "a turn materializes t-old"
    );
    assert!(a.signal_native(SIGKILL));
    let new_lock = thread_lock_path(home.path(), "t-new");
    wait_until("A's locks released", Duration::from_secs(2), || {
        !lock_held(&new_lock) && !lock_held(&thread_lock_path(home.path(), "t-old"))
    })
    .await;

    // By default, like Codex, B resumes only a thread with a rollout.
    let b = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut rpc_b = connected(b.port).await;
    let refused = rpc_b
        .call("thread/resume", json!({"threadId": "t-new"}))
        .await
        .expect_err("a turnless thread has no rollout");
    assert_eq!(refused["code"], -32600);
    assert_eq!(refused["message"], "no rollout found for thread id t-new");
    assert!(!lock_held(&new_lock), "a refused resume takes no lock");

    let mut tui = FakeTui::spawn(
        &format!("ws://127.0.0.1:{}", b.port),
        &["resume", "t-new"],
        &[],
    )
    .await;
    assert!(
        tui.wait_output(
            "No saved session found with ID t-new",
            Duration::from_secs(5)
        )
        .await,
        "{}",
        tui.output()
    );
    let status = tui
        .wait_exit(Duration::from_secs(5))
        .await
        .expect("the TUI exits");
    assert_eq!(status.code(), Some(1));

    rpc_b
        .call("thread/resume", json!({"threadId": "t-old"}))
        .await
        .expect("a materialized thread resumes");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tui_survives_app_server_death_and_reconnects() {
    // (1) Reconnects to a new app-server on the same port and re-resumes its thread.
    let home = tempfile::tempdir().unwrap();
    seed_rollout(home.path(), "t-r");
    let a = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let remote = format!("ws://127.0.0.1:{}", a.port);
    let mut tui = FakeTui::spawn(&remote, &["resume", "t-r"], &[]).await;
    assert!(
        tui.wait_output("FAKE_TUI_READY thread=t-r", Duration::from_secs(10))
            .await,
        "{}",
        tui.output()
    );
    assert!(a.signal_native(SIGKILL));
    assert!(
        tui.wait_output("FAKE_TUI_RECONNECTING", Duration::from_secs(2))
            .await,
        "{}",
        tui.output()
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(tui.is_running(), "the TUI never exits on app-server death");
    let _b = FakeAppServer::spawn_on_port(a.port, json!({}), home.path(), &[]).await;
    assert!(
        tui.wait_output_count("FAKE_TUI_READY thread=t-r", 2, Duration::from_secs(15))
            .await,
        "{}",
        tui.output()
    );
    assert!(tui.is_running());

    // (2) Gives up after the reconnect deadline and keeps running until quit.
    let home2 = tempfile::tempdir().unwrap();
    let c = FakeAppServer::spawn(json!({}), home2.path(), &[]).await;
    let mut tui2 = FakeTui::spawn(
        &format!("ws://127.0.0.1:{}", c.port),
        &[],
        &[("FAKE_TUI_RECONNECT_DEADLINE_MS", "1500")],
    )
    .await;
    assert!(
        tui2.wait_output("FAKE_TUI_READY", Duration::from_secs(10))
            .await,
        "{}",
        tui2.output()
    );
    assert!(c.signal_native(SIGKILL));
    assert!(
        tui2.wait_output(
            "Server connection could not be restored",
            Duration::from_secs(5)
        )
        .await,
        "{}",
        tui2.output()
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(tui2.is_running(), "the TUI keeps running after giving up");
    tui2.send("quit").await;
    let status = tui2
        .wait_exit(Duration::from_secs(5))
        .await
        .expect("quit exits");
    assert_eq!(status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tui_rejects_a_remote_url_with_a_path() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut bad = FakeTui::spawn(&format!("ws://127.0.0.1:{}/codex", fake.port), &[], &[]).await;
    assert!(
        bad.wait_output("invalid remote address", Duration::from_secs(5))
            .await,
        "{}",
        bad.output()
    );
    let status = bad
        .wait_exit(Duration::from_secs(5))
        .await
        .expect("a path URL exits");
    assert_eq!(status.code(), Some(1));
    let mut good = FakeTui::spawn(&format!("ws://127.0.0.1:{}", fake.port), &[], &[]).await;
    assert!(
        good.wait_output("FAKE_TUI_READY", Duration::from_secs(10))
            .await,
        "{}",
        good.output()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tui_rings_bel_only_for_completed_turns() {
    // A completed turn rings once.
    let home = tempfile::tempdir().unwrap();
    let quick = FakeAppServer::spawn(json!({"turnCompleteDelayMs": 300}), home.path(), &[]).await;
    let mut tui = FakeTui::spawn(&format!("ws://127.0.0.1:{}", quick.port), &[], &[]).await;
    assert!(
        tui.wait_output("FAKE_TUI_READY", Duration::from_secs(10))
            .await,
        "{}",
        tui.output()
    );
    tui.send("turn one").await;
    assert!(
        tui.wait_output(
            "FAKE_TUI_TURN_COMPLETED status=completed",
            Duration::from_secs(5)
        )
        .await,
        "{}",
        tui.output()
    );
    wait_until(
        "BEL after the completed turn",
        Duration::from_secs(2),
        || tui.bel_count() == 1,
    )
    .await;

    // An interrupted turn does not ring. (Each fake has one turn delay, so the
    // interrupted case runs a second TUI against a slow fake.)
    let home2 = tempfile::tempdir().unwrap();
    let slow = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 60000, "threadStartThreadId": "t-bel"}),
        home2.path(),
        &[],
    )
    .await;
    let mut observer = connected(slow.port).await;
    let mut tui2 = FakeTui::spawn(&format!("ws://127.0.0.1:{}", slow.port), &[], &[]).await;
    assert!(
        tui2.wait_output("FAKE_TUI_READY thread=t-bel", Duration::from_secs(10))
            .await,
        "{}",
        tui2.output()
    );
    tui2.send("turn two").await;
    observer
        .next_notification_for("turn/started", "t-bel", Duration::from_secs(5))
        .await
        .expect("the TUI's turn starts");
    observer
        .call("turn/interrupt", json!({"threadId": "t-bel"}))
        .await
        .expect("interrupt");
    assert!(
        tui2.wait_output(
            "FAKE_TUI_TURN_COMPLETED status=interrupted",
            Duration::from_secs(5)
        )
        .await,
        "{}",
        tui2.output()
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(tui2.bel_count(), 0, "an interrupted turn never rings");
    assert_eq!(tui.bel_count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn signals_carry_the_unit_record_state_and_wedge_knobs_hold() {
    // Later tasks prove "Stopping is persisted before any signal" from this field.
    let home = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    std::fs::write(
        records.path().join("utest.json"),
        r#"{"unitId":"utest","state":{"kind":"stopping","mode":"force"}}"#,
    )
    .unwrap();
    let fake = FakeAppServer::spawn(
        json!({"ignoreSigint": true, "ignoreSigterm": true}),
        home.path(),
        &[
            ("FRESHELL_UNIT_ID", "utest"),
            ("FAKE_UNIT_RECORD_DIR", records.path().to_str().unwrap()),
        ],
    )
    .await;
    let native = fake.native().await.pid;
    assert!(fake.signal_native(SIGINT));
    wait_until("SIGINT recorded", Duration::from_secs(2), || {
        fake.try_native().is_some_and(|m| m.signals.len() == 1)
    })
    .await;
    assert!(fake.signal_native(SIGTERM));
    wait_until("SIGTERM recorded", Duration::from_secs(2), || {
        fake.try_native().is_some_and(|m| m.signals.len() == 2)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        pid_alive(native),
        "ignoreSigint and ignoreSigterm leave a wedged native running"
    );
    let m = fake.native().await;
    for (entry, sig) in m.signals.iter().zip(["SIGINT", "SIGTERM"]) {
        assert_eq!(entry.sig, sig);
        assert_eq!(
            entry.record_state.as_deref(),
            Some(r#"{"kind":"stopping","mode":"force"}"#)
        );
    }
    assert!(fake.signal_native(SIGKILL));

    // Without a unit record the field is null.
    let plain = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    assert!(plain.signal_native(SIGHUP));
    wait_until("SIGHUP recorded", Duration::from_secs(2), || {
        plain.try_native().is_some_and(|m| m.signals.len() == 1)
    })
    .await;
    let entry = &plain.native().await.signals[0];
    assert_eq!(entry.sig, "SIGHUP");
    assert_eq!(entry.record_state, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn listen_delay_holds_off_the_listener() {
    let home = tempfile::tempdir().unwrap();
    let t0 = Instant::now();
    // On a port of its own: it binds no port at all until it listens.
    let mut fake =
        FakeAppServer::spawn_on_its_own_port(json!({"listenDelayMs": 1500}), home.path(), &[])
            .await;
    let native = fake.native().await;
    assert!(
        listening_sockets_of(native.pid).is_empty(),
        "nothing listens while listenDelayMs runs"
    );
    assert!(!native.listening, "nor does the native say it listens");
    fake.listened().await.expect("the native listens");
    assert!(t0.elapsed() >= Duration::from_millis(1500));
    assert_eq!(
        listening_sockets_of(native.pid),
        [fake.port],
        "then it listens on the port it reported"
    );
    let _rpc = connected(fake.port).await;
}

/// The local ports of the TCP sockets `pid` holds that are listening (Linux:
/// its socket descriptors matched against `/proc/net/tcp{,6}`).
fn listening_sockets_of(pid: u32) -> Vec<u16> {
    let inodes: Vec<String> = std::fs::read_dir(format!("/proc/{pid}/fd"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|fd| std::fs::read_link(fd.path()).ok())
        .filter_map(|target| {
            let target = target.to_string_lossy();
            Some(
                target
                    .strip_prefix("socket:[")?
                    .strip_suffix(']')?
                    .to_string(),
            )
        })
        .collect();
    let mut ports = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let raw = std::fs::read_to_string(table).unwrap_or_default();
        for line in raw.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            // Field 3 is the state (0A: LISTEN), field 9 the socket's inode.
            if f.len() > 9 && f[3] == "0A" && inodes.iter().any(|inode| inode == f[9]) {
                let port = f[1].rsplit(':').next().unwrap_or_default();
                ports.extend(u16::from_str_radix(port, 16).ok());
            }
        }
    }
    ports
}

#[tokio::test(flavor = "multi_thread")]
async fn loaded_list_pages_and_approval_waiting_is_reported() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"preloadedThreads": ["t-c", "t-a", "t-b"], "approvalWaiting": ["t-a"]}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = connected(fake.port).await;
    let first = rpc
        .call("thread/loaded/list", json!({"limit": 2}))
        .await
        .unwrap();
    assert_eq!(first["data"], json!(["t-a", "t-b"]));
    assert_eq!(first["nextCursor"], "2");
    let rest = rpc
        .call("thread/loaded/list", json!({"limit": 2, "cursor": "2"}))
        .await
        .unwrap();
    assert_eq!(rest["data"], json!(["t-c"]));
    assert_eq!(rest["nextCursor"], Value::Null);
    let waiting = rpc
        .call("thread/read", json!({"threadId": "t-a"}))
        .await
        .unwrap();
    assert_eq!(
        waiting["thread"]["status"],
        json!({"type": "active", "activeFlags": ["waitingOnApproval"]})
    );
    let idle = rpc
        .call("thread/read", json!({"threadId": "t-b"}))
        .await
        .unwrap();
    assert_eq!(idle["thread"]["status"]["type"], "idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draining_native_refuses_turns_and_a_second_sigterm_exits_at_once() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"turnCompleteDelayMs": 60000, "threadStartThreadId": "t-dr"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = connected(fake.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-dr").await;
    let native = fake.native().await.pid;
    assert!(fake.signal_native(SIGTERM));
    wait_until("SIGTERM recorded", Duration::from_secs(2), || {
        fake.try_native().is_some_and(|m| m.signals.len() == 1)
    })
    .await;
    let refused = rpc
        .call(
            "turn/start",
            json!({"threadId": "t-dr", "input": [{"type":"text","text":"more"}]}),
        )
        .await
        .expect_err("a draining native refuses new turns");
    assert_eq!(refused["code"], -32001);
    assert_eq!(refused["message"], "app-server is draining");
    assert!(pid_alive(native), "the running turn keeps the native alive");
    let t0 = Instant::now();
    assert!(fake.signal_native(SIGTERM));
    wait_until(
        "native exit after a second SIGTERM",
        Duration::from_secs(2),
        || !pid_alive(native),
    )
    .await;
    assert!(t0.elapsed() < Duration::from_millis(1000));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_compiled_lock_holder_behaves_like_codexs_writer_lock() {
    use tokio::io::{AsyncBufReadExt, BufReader};

    async fn holder(lock: &Path) -> (tokio::process::Child, String) {
        let mut child = tokio::process::Command::new(lock_holder_exe())
            .arg(lock)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn lock holder");
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(stdout).read_line(&mut line),
        )
        .await
        .expect("holder answers in time")
        .expect("read holder output");
        (child, line.trim().to_string())
    }

    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("sub").join("t.lock");
    let (mut a, said) = holder(&lock).await;
    assert_eq!(said, "locked");
    let (mut b, said) = holder(&lock).await;
    assert_eq!(said, "conflict");
    let b_status = tokio::time::timeout(Duration::from_secs(5), b.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(b_status.code(), Some(1));
    drop(a.stdin.take());
    let a_status = tokio::time::timeout(Duration::from_secs(5), a.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(a_status.code(), Some(0));
    let (mut c, said) = holder(&lock).await;
    assert_eq!(said, "locked", "the lock is free once its holder ends");
    drop(c.stdin.take());
    let c_status = tokio::time::timeout(Duration::from_secs(5), c.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(c_status.code(), Some(0));
}

#[tokio::test(flavor = "multi_thread")]
async fn signal_own_child_signals_only_the_pinned_process() {
    use std::os::unix::process::ExitStatusExt;
    let mut child = tokio::process::Command::new("sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn sleep");
    let pid = child.id().expect("child pid");
    let start = proc_starttime(pid).expect("our unreaped child's start time");
    assert!(
        !signal_own_child(pid, start + 1, SIGKILL),
        "another start time names another process: nothing is sent"
    );
    assert!(
        pid_alive(pid),
        "the mismatched signal never reached the child"
    );
    assert!(signal_own_child(pid, start, SIGKILL));
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("the pinned child dies")
        .expect("wait for the child");
    assert_eq!(status.signal(), Some(SIGKILL));
    assert!(
        !signal_own_child(pid, start, SIGKILL),
        "a reaped process is never signalled"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn every_reported_process_is_pinned_and_ends_with_the_fake() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"spawnHelperProcess": true, "mcpChild": true, "turnSpawnsShellCommand": true,
               "detachedJobOnTurn": true, "turnCompleteDelayMs": 60000, "threadStartThreadId": "t-pin"}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = connected(fake.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-pin").await;
    wait_until("turn descendants", Duration::from_secs(5), || {
        fake.try_native()
            .is_some_and(|m| !m.children.shell.is_empty() && !m.children.detached.is_empty())
    })
    .await;
    let m = fake.native().await;
    let mut pinned = vec![
        m.pid,
        m.children.helper.expect("helper"),
        m.children.mcp.expect("mcp child"),
    ];
    pinned.extend(&m.children.shell);
    pinned.extend(&m.children.detached);
    let identities: Vec<(u32, u64)> = pinned.iter().map(|&pid| (pid, m.start_time(pid))).collect();
    for &(pid, start) in &identities {
        assert_eq!(
            Some(start),
            proc_starttime(pid),
            "the native pinned {pid} by its real start time"
        );
    }
    assert_eq!(
        Some(fake.launcher_start_time()),
        proc_starttime(fake.launcher_pid()),
        "the launcher is pinned too"
    );

    // A test that ends early (a failing assertion) must not leave any of them behind.
    drop(fake);
    wait_until(
        "every pinned process ended with the fake",
        Duration::from_secs(5),
        || {
            identities
                .iter()
                .all(|&(pid, start)| !(pid_alive(pid) && proc_starttime(pid) == Some(start)))
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_native_refuses_to_run_without_an_explicit_codex_home() {
    // Unset or empty, CODEX_HOME would fall back to `~/.codex` (here a throwaway HOME),
    // where the native would create, lock and delete real thread lock files.
    for codex_home in [None, Some("")] {
        let home = tempfile::tempdir().unwrap();
        let run = launcher_exit(
            json!({"preloadedThreads": ["t-home"]}),
            home.path(),
            codex_home,
        )
        .await;
        let stderr = &run.stderr;
        assert_eq!(run.code, Some(1), "CODEX_HOME={codex_home:?}: {stderr}");
        assert!(
            stderr.contains("requires an explicit CODEX_HOME"),
            "CODEX_HOME={codex_home:?}: {stderr}"
        );
        assert!(
            !home.path().join(".codex").exists(),
            "CODEX_HOME={codex_home:?}: nothing is created under the default Codex home"
        );
    }
}

/// The single-process fake never falls back to the real user's `~/.codex`
/// (Freshell reads and walks whatever Codex home the fake reports). With
/// `CODEX_HOME` and `HOME` both unset, its fallback home comes from the
/// password database, the real one: the fake refuses to start, before it
/// reads or writes anything, and says why. With an isolated `HOME` it starts
/// and reports `<HOME>/.codex` as before.
#[tokio::test(flavor = "multi_thread")]
async fn the_single_process_fake_refuses_the_real_users_codex_home() {
    use tokio::io::AsyncReadExt;
    let command = |home: Option<&Path>| {
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(fixture_path("fake-app-server.mjs"))
            .env_remove("CODEX_HOME")
            .env_remove("HOME")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = home {
            cmd.env("HOME", home);
        }
        cmd
    };

    let mut refused = command(None)
        .args([
            "--listen",
            &format!("ws://127.0.0.1:{}", unique_free_port()),
        ])
        .spawn()
        .expect("spawn the single-process fake");
    let mut stderr = refused.stderr.take().expect("the fake's stderr");
    let status = tokio::time::timeout(Duration::from_secs(5), refused.wait())
        .await
        .expect("the fake exits at once")
        .expect("wait for the fake");
    let mut text = String::new();
    let _ = stderr.read_to_string(&mut text).await;
    assert_eq!(status.code(), Some(1), "{text}");
    assert!(
        text.contains("CODEX_HOME is unset") && text.contains("never uses the real ~/.codex"),
        "{text}"
    );

    // This one listens: on a port the kernel gives it as it binds, which no
    // other socket can take first.
    let home = tempfile::tempdir().unwrap();
    let (mut isolated, port) = lost_port::spawn_on_its_own_port(command(Some(home.path()))).await;
    let mut rpc = Rpc::connect(port).await;
    let ready = rpc
        .call(
            "initialize",
            json!({"clientInfo": {"name": "t", "version": "1"}}),
        )
        .await
        .expect("initialize");
    assert_eq!(
        ready["codexHome"],
        json!(home.path().join(".codex")),
        "an isolated HOME keeps working: {ready}"
    );
    isolated.kill().await.expect("stop this test's own fake");
}

/// The real user's home directory as the fakes see it: Node's password-database
/// entry (`os.userInfo().homedir`), which no `HOME` setting changes.
fn real_users_home() -> std::path::PathBuf {
    let out = std::process::Command::new("node")
        .args([
            "-e",
            "process.stdout.write(require('node:os').userInfo().homedir)",
        ])
        .output()
        .expect("run node");
    assert!(out.status.success(), "node: {out:?}");
    std::path::PathBuf::from(String::from_utf8(out.stdout).expect("utf-8 home"))
}

/// A path inside the real user's `~/.codex` that no one creates: the guard must
/// refuse it from its text alone, so no file system call ever reaches it.
fn a_path_inside_the_real_users_codex_home() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    real_users_home()
        .join(".codex")
        .join(format!(
            "freshell-fixture-guard-{}-{nanos}",
            std::process::id()
        ))
        .join("home")
}

/// The single-process fake (stderr piped) under `home`, with `CODEX_HOME` set only
/// when given.
fn single_process_fake(home: &Path, codex_home: Option<&Path>) -> tokio::process::Child {
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(fixture_path("fake-app-server.mjs"))
        .args([
            "--listen",
            &format!("ws://127.0.0.1:{}", unique_free_port()),
        ])
        .env("HOME", home)
        .env_remove("CODEX_HOME")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(codex_home) = codex_home {
        cmd.env("CODEX_HOME", codex_home);
    }
    cmd.spawn().expect("spawn the single-process fake")
}

/// Waits up to 5 s for `child` to exit and returns its exit code (`None`: still
/// running, killed by `kill_on_drop`) with everything it wrote to stderr.
async fn exit_and_stderr(mut child: tokio::process::Child) -> (Option<i32>, String) {
    use tokio::io::AsyncReadExt;
    let mut stderr = child.stderr.take().expect("the child's stderr");
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text).await;
            (status.expect("wait for the child").code(), text)
        }
        Err(_) => (None, String::new()),
    }
}

/// An explicit (or inherited) `CODEX_HOME` inside the real user's `~/.codex` is
/// refused too, not only the unset-`CODEX_HOME` fallback: the fake exits 1 at
/// startup and says why, with a throwaway `HOME` so only `CODEX_HOME` points at
/// the real store.
#[tokio::test(flavor = "multi_thread")]
async fn the_single_process_fake_refuses_an_explicit_codex_home_inside_the_real_one() {
    let home = tempfile::tempdir().unwrap();
    let inside = a_path_inside_the_real_users_codex_home();
    let child = single_process_fake(home.path(), Some(&inside));
    let (code, stderr) = exit_and_stderr(child).await;
    assert_eq!(code, Some(1), "the fake refuses at once: {stderr}");
    assert!(
        stderr.contains("is the real user's Codex home or inside it")
            && stderr.contains("never uses the real ~/.codex"),
        "{stderr}"
    );
}

/// The native role keeps the same rule on its own (it creates, locks and
/// deletes real thread lock files under its Codex home).
#[tokio::test(flavor = "multi_thread")]
async fn the_native_role_refuses_a_codex_home_inside_the_real_one() {
    let inside = a_path_inside_the_real_users_codex_home();
    let script = format!(
        "const {{ createNativeRole }} = await import({native});\n\
         createNativeRole({{ behavior: {{}}, codexHome: process.argv[1], broadcast() {{}},\n\
           hasRollout: () => false, materialize() {{}}, openConnections: () => [], sendTo() {{}} }})\n\
         process.stderr.write('the native role started\\n')\n",
        native = serde_json::to_string(
            &url_of(&fixture_path("native-role.mjs"))
        )
        .unwrap()
    );
    let child = tokio::process::Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .arg(&inside)
        .env_remove("CODEX_HOME")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn node with the native role");
    let (code, stderr) = exit_and_stderr(child).await;
    assert_eq!(code, Some(1), "the native role refuses at once: {stderr}");
    assert!(
        stderr.contains("is the real user's Codex home or inside it")
            && stderr.contains("never uses the real ~/.codex")
            && !stderr.contains("the native role started"),
        "{stderr}"
    );
}

/// `file://` URL of an absolute path, for a dynamic `import()`.
fn url_of(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// The home check compares real paths, not text: a `HOME` that is a symlink
/// to a directory inside the real user's home is refused like that directory
/// itself (`CODEX_HOME` unset, so the fallback would be `<real home>/…/.codex`).
/// The symlink's target is this test's own directory, never `~/.codex`.
#[tokio::test(flavor = "multi_thread")]
async fn the_single_process_fake_refuses_a_symlinked_home_into_the_real_one() {
    let real_home = real_users_home();
    let real_home_resolved = real_home.canonicalize().expect("the real home exists");
    // A directory of this test's own inside the real home: Cargo's per-target
    // temp dir when it lies there (the usual checkout), else a temp dir directly
    // in the real home. Removed when the test ends.
    let cargo_tmp = Path::new(env!("CARGO_TARGET_TMPDIR"));
    let target = if cargo_tmp
        .canonicalize()
        .is_ok_and(|dir| dir.starts_with(&real_home_resolved))
    {
        tempfile::tempdir_in(cargo_tmp).unwrap()
    } else {
        tempfile::Builder::new()
            .prefix(".freshell-fixture-guard-")
            .tempdir_in(&real_home)
            .unwrap()
    };
    let link_parent = tempfile::tempdir_in("/tmp").unwrap();
    let link = link_parent.path().join("home");
    std::os::unix::fs::symlink(target.path(), &link).unwrap();
    assert!(
        !link.starts_with(&real_home) && !link.starts_with(&real_home_resolved),
        "precondition: the symlinked HOME {} is outside the real home by its text",
        link.display()
    );
    let child = single_process_fake(&link, None);
    let (code, stderr) = exit_and_stderr(child).await;
    assert_eq!(code, Some(1), "the fake refuses at once: {stderr}");
    assert!(
        stderr.contains("CODEX_HOME is unset") && stderr.contains("never uses the real ~/.codex"),
        "{stderr}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_start_or_resume_holds_no_lock() {
    // (1) Error overrides: real Codex holds nothing for a start or resume it refused.
    let home = tempfile::tempdir().unwrap();
    let refusal = json!({"code": -32603, "message": "fixture refusal"});
    let refusing = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-ref",
               "overrides": {"thread/start": {"error": refusal},
                             "thread/resume": {"error": refusal}}}),
        home.path(),
        &[],
    )
    .await;
    let mut rpc = connected(refusing.port).await;
    let start = rpc
        .call("thread/start", json!({}))
        .await
        .expect_err("start refused");
    assert_eq!(start, refusal);
    let resume = rpc
        .call("thread/resume", json!({"threadId": "t-res"}))
        .await
        .expect_err("resume refused");
    assert_eq!(resume, refusal);
    let loaded = rpc.call("thread/loaded/list", json!({})).await.unwrap();
    assert_eq!(
        loaded["data"],
        json!([]),
        "a refused thread is never loaded"
    );
    for id in ["t-ref", "t-res"] {
        assert!(
            !lock_held(&thread_lock_path(home.path(), id)),
            "{id}: a refused open holds no lock"
        );
    }
    // Another app-server can open both right away (both had turns).
    seed_rollout(home.path(), "t-ref");
    seed_rollout(home.path(), "t-res");
    let other = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut rpc2 = connected(other.port).await;
    for id in ["t-ref", "t-res"] {
        rpc2.call("thread/resume", json!({"threadId": id}))
            .await
            .unwrap_or_else(|e| panic!("{id} is free to open elsewhere: {e}"));
    }

    // (2) assertNoDuplicateActiveThread: the refused second start holds nothing.
    let home2 = tempfile::tempdir().unwrap();
    let dup = FakeAppServer::spawn(
        json!({"assertNoDuplicateActiveThread": true}),
        home2.path(),
        &[],
    )
    .await;
    let mut rpc3 = connected(dup.port).await;
    let first = rpc3.call("thread/start", json!({})).await.unwrap()["thread"]["id"]
        .as_str()
        .expect("first thread id")
        .to_string();
    let refused = rpc3
        .call("thread/start", json!({}))
        .await
        .expect_err("a second active thread is refused");
    assert_eq!(refused["code"], -32001);
    let loaded = rpc3.call("thread/loaded/list", json!({})).await.unwrap();
    assert_eq!(loaded["data"], json!([first]));
    assert_eq!(
        dup.native().await.threads,
        vec![first],
        "the native holds only the first thread's lock"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_preloaded_thread_held_elsewhere_fails_the_native_at_startup() {
    let home = tempfile::tempdir().unwrap();
    let holder =
        FakeAppServer::spawn(json!({"threadStartThreadId": "t-pre"}), home.path(), &[]).await;
    let mut rpc = connected(holder.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    let held = thread_lock_path(home.path(), "t-pre");

    let run = launcher_exit(
        json!({"preloadedThreads": ["t-free", "t-pre"], "spawnHelperProcess": true, "mcpChild": true}),
        home.path(),
        Some(home.path().to_str().unwrap()),
    )
    .await;
    assert_eq!(
        run.code,
        Some(1),
        "a setup mistake fails at startup: {}",
        run.stderr
    );
    assert!(
        run.stderr.contains(
            "preloaded thread t-pre could not be locked: \
             thread-store conflict: thread t-pre already has an active writer"
        ),
        "{}",
        run.stderr
    );
    let native = run.native.expect("the failed native's manifest");
    assert_eq!(
        native.children.helper, None,
        "no child starts before the preloads are locked"
    );
    assert_eq!(
        native.children.mcp, None,
        "no child starts before the preloads are locked"
    );
    assert!(
        holds_lock_fd(holder.native().await.pid, &held),
        "the holder keeps its lock"
    );
    assert!(
        !lock_held(&thread_lock_path(home.path(), "t-free")),
        "the failed native's other preload ended with it"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turns_rollout_is_on_disk_before_turn_start_is_answered() {
    let home = tempfile::tempdir().unwrap();
    // The helper spawn gives the native real work (a flock) right after it answers, so
    // a rollout written after the answer is reliably caught missing.
    let fake = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-roll", "turnCompleteDelayMs": 60000,
               "helperThreadOnTurn": {"id": "t-roll-helper", "durationMs": 60000}}),
        home.path(),
        &[],
    )
    .await;
    let native = fake.native().await.pid;
    let mut rpc = connected(fake.port).await;
    rpc.call("thread/start", json!({})).await.unwrap();
    assert!(
        !rollout_exists(home.path(), "t-roll"),
        "thread/start alone writes no rollout"
    );
    start_turn(&mut rpc, "t-roll").await;
    // SIGKILLed the instant turn/start is answered: nothing after the answer runs.
    assert!(fake.signal_native(SIGKILL));
    wait_until("native exit", Duration::from_secs(2), || !pid_alive(native)).await;
    assert!(
        rollout_exists(home.path(), "t-roll"),
        "the rollout exists once turn/start has been answered"
    );
    wait_until("lock release", Duration::from_secs(2), || {
        !lock_held(&thread_lock_path(home.path(), "t-roll"))
    })
    .await;
    let b = FakeAppServer::spawn(json!({"resumeNeedsRollout": true}), home.path(), &[]).await;
    connected(b.port)
        .await
        .call("thread/resume", json!({"threadId": "t-roll"}))
        .await
        .expect("a conversation killed right after turn/start resumes");
}
