#![cfg(all(feature = "real-transport", target_os = "linux"))]
//! The realistic Codex fake must reproduce the process and lock facts the
//! lifecycle work depends on (design §3). Every signalled pid was spawned here.

#[path = "support/fake_codex.rs"]
mod fake_codex;

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

/// The pid column of the `/proc/locks` row for `path`'s inode.
fn locks_row_pid(path: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    let needle = format!(":{} ", std::fs::metadata(path).ok()?.ino());
    std::fs::read_to_string("/proc/locks")
        .ok()?
        .lines()
        .find(|l| l.contains("FLOCK") && format!("{l} ").contains(&needle))?
        .split_whitespace()
        .nth(4)?
        .parse()
        .ok()
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
    signal_own_child(fake.launcher_pid(), SIGTERM);
    tokio::time::sleep(Duration::from_millis(200)).await;
    signal_own_child(fake.launcher_pid(), SIGINT);
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
    signal_own_child(native.pid, SIGKILL);
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
    signal_own_child(native, SIGTERM);
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
    signal_own_child(native, SIGINT);
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
    signal_own_child(native, SIGINT);
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
        signal_own_child(pid, SIGKILL);
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
    assert!(lock_held(&lock), "native A holds the thread lock");
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
    signal_own_child(a.native().await.pid, SIGKILL);
    wait_until("lock release", Duration::from_secs(2), || !lock_held(&lock)).await;
    rpc_b
        .call("thread/resume", json!({"threadId": "t-lock"}))
        .await
        .expect("resume after release");
    signal_own_child(b.native().await.pid, SIGKILL);
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
    let row_pid = locks_row_pid(&lock).expect("a /proc/locks row for the thread lock");
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
    for id in ["t-root", "t-helper", "t-earlier"] {
        assert!(ids.contains(&id.to_string()), "{id} loaded");
        assert!(lock_held(&thread_lock_path(home.path(), id)), "{id} locked");
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
    signal_own_child(fake.native().await.pid, SIGKILL);
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
    signal_own_child(first.native().await.pid, SIGKILL);
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
        lock_held(&thread_lock_path(home.path(), &child)),
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
    // the file deleted, then notLoaded and thread/closed are broadcast.
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
    assert!(lock_held(&lock), "t-u is locked while loaded");
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
    let loaded = observer
        .call("thread/loaded/list", json!({}))
        .await
        .unwrap();
    assert!(!loaded["data"].as_array().unwrap().contains(&json!("t-u")));

    // (2) A helper closed by its parent: interrupted turn, notLoaded, lock released,
    // no thread/closed.
    let home2 = tempfile::tempdir().unwrap();
    let closing = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-cr", "threadUnloadDelayMs": 300,
               "helperThreadOnTurn": {"id": "t-c", "durationMs": 60000, "closeAfterMs": 300}}),
        home2.path(),
        &[],
    )
    .await;
    let mut observer2 = connected(closing.port).await;
    let mut driver2 = connected(closing.port).await;
    driver2.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut driver2, "t-cr").await;
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
        !lock_held(&thread_lock_path(home2.path(), "t-c")),
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
    let a = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-new", "turnCompleteDelayMs": 50}),
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
    signal_own_child(a.native().await.pid, SIGKILL);
    let new_lock = thread_lock_path(home.path(), "t-new");
    wait_until("A's locks released", Duration::from_secs(2), || {
        !lock_held(&new_lock) && !lock_held(&thread_lock_path(home.path(), "t-old"))
    })
    .await;

    let b = FakeAppServer::spawn(json!({"resumeNeedsRollout": true}), home.path(), &[]).await;
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
    let a = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let remote = format!("ws://127.0.0.1:{}", a.port);
    let mut tui = FakeTui::spawn(&remote, &["resume", "t-r"], &[]).await;
    assert!(
        tui.wait_output("FAKE_TUI_READY thread=t-r", Duration::from_secs(10))
            .await,
        "{}",
        tui.output()
    );
    signal_own_child(a.native().await.pid, SIGKILL);
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
    signal_own_child(c.native().await.pid, SIGKILL);
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
    signal_own_child(native, SIGINT);
    wait_until("SIGINT recorded", Duration::from_secs(2), || {
        fake.try_native().is_some_and(|m| m.signals.len() == 1)
    })
    .await;
    signal_own_child(native, SIGTERM);
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
    signal_own_child(native, SIGKILL);

    // Without a unit record the field is null.
    let plain = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let native = plain.native().await.pid;
    signal_own_child(native, SIGHUP);
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
    let fake = FakeAppServer::spawn(json!({"listenDelayMs": 1500}), home.path(), &[]).await;
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", fake.port)).is_err(),
        "nothing listens while listenDelayMs runs"
    );
    let _rpc = connected(fake.port).await;
    assert!(t0.elapsed() >= Duration::from_millis(1500));
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
    signal_own_child(native, SIGTERM);
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
    signal_own_child(native, SIGTERM);
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
