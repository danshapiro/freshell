//! ProcWatch is the event-driven, pid-reuse-safe exit watch every Gone
//! decision rests on. Every process signalled here was spawned by the test.
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

#[cfg(unix)]
use freshell_containment::identity;
use freshell_containment::{is_codex_daemon_family, ProcWatch, Sig, UnitId};

#[test]
fn unit_id_is_dash_free_and_round_trips() {
    let id = UnitId::mint();
    assert!(id.as_str().starts_with('u'));
    assert_eq!(id.as_str().len(), 33);
    assert!(!id.as_str().contains('-'));
    assert_eq!(UnitId::parse(id.as_str()), Some(id.clone()));
    assert_eq!(UnitId::parse("u-not-valid"), None);
    assert_eq!(UnitId::parse("x0123456789abcdef0123456789abcdef"), None);
}

#[test]
fn codex_daemon_family_is_recognised_by_each_members_own_argv() {
    fn argv(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_string).collect()
    }
    let spared = [
        // The current managed daemon.
        "/opt/codex/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon",
        // Its capability probe.
        "/opt/codex/bin/codex app-server --managed-daemon --help",
        // The updater (a sibling of the daemon, never its descendant).
        "/opt/codex/bin/codex app-server daemon pid-update-loop",
        "/opt/codex/bin/codex app-server daemon pid-update-loop --restore-release 0.161.0",
        // The legacy managed launch, without the optional flag.
        "/opt/codex/bin/codex app-server --listen unix:// --analytics-default-enabled",
        "/opt/codex/bin/codex app-server --remote-control --listen unix://",
    ];
    for line in spared {
        assert!(
            is_codex_daemon_family(&argv(line)),
            "must be spared: {line}"
        );
    }
    let not_spared = [
        // Freshell's own sidecar app-server behind the Node launcher.
        "node /opt/codex/bin/codex -c features.apps=false app-server --listen ws://127.0.0.1:41000",
        // The pane's screen.
        "/opt/codex/bin/codex --remote ws://127.0.0.1:41000 resume t-1",
        "/opt/codex/bin/codex exec resume t-1",
        // The flag alone, with no app-server.
        "/x/other --managed-daemon",
        // The flag BEFORE app-server is not the daemon's argv.
        "/opt/codex/bin/codex --managed-daemon app-server --listen ws://127.0.0.1:1",
        // The updater words without app-server.
        "/opt/codex/bin/codex daemon pid-update-loop",
    ];
    for line in not_spared {
        assert!(
            !is_codex_daemon_family(&argv(line)),
            "must not be spared: {line}"
        );
    }
    assert!(!is_codex_daemon_family(&[]));
}

#[cfg(unix)]
fn spawn_grandchild(seconds: &str) -> u32 {
    spawn_grandchild_cmd(&format!("sleep {seconds}"))
}

/// Start `command` as a grandchild (its `sh` parent exits at once), so the
/// test process is never its parent and cannot reap it.
#[cfg(unix)]
fn spawn_grandchild_cmd(command: &str) -> u32 {
    let out = std::process::Command::new("sh")
        .args(["-c", &format!("{command} >/dev/null 2>&1 & echo $!")])
        .output()
        .unwrap();
    String::from_utf8(out.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_fires_for_a_non_child_when_it_exits() {
    const LIFETIME: Duration = Duration::from_millis(400);
    // Measured from before the spawn: the process cannot exit sooner than
    // LIFETIME after this instant, however slowly the spawn and open run.
    let t0 = Instant::now();
    let pid = spawn_grandchild(&format!("{}", LIFETIME.as_secs_f64()));
    let watch = ProcWatch::open(pid).expect("open");
    assert!(!watch.has_exited());
    tokio::time::timeout(Duration::from_secs(5), watch.exited())
        .await
        .expect("exit event")
        .expect("watch registered");
    assert!(watch.has_exited());
    // `exited` waited for the exit rather than resolving at once.
    assert!(
        t0.elapsed() >= LIFETIME,
        "resolved after {:?}",
        t0.elapsed()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_signal_ends_the_watched_process() {
    let pid = spawn_grandchild("600");
    let watch = ProcWatch::open(pid).unwrap();
    assert_eq!(watch.identity().pid, pid);
    watch.signal(Sig::Kill).unwrap();
    tokio::time::timeout(Duration::from_secs(5), watch.exited())
        .await
        .expect("killed")
        .expect("watch registered");
    // Signalling an exited process is a quiet no-op, never a stray signal.
    watch.signal(Sig::Kill).unwrap();
}

/// Waits for Gone are cancelled with their request; a cancelled wait must
/// leave the watch usable, and concurrent waits on one watch all resolve.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_wait_leaves_the_watch_usable_and_concurrent_waits_all_resolve() {
    let pid = spawn_grandchild("600");
    let watch = ProcWatch::open(pid).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), watch.exited())
            .await
            .is_err(),
        "a live process must not be reported exited"
    );
    let waiters: Vec<_> = (0..3)
        .map(|_| {
            let watch = watch.clone();
            tokio::spawn(async move { watch.exited().await })
        })
        .collect();
    watch.signal(Sig::Kill).unwrap();
    for waiter in waiters {
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("every waiter sees the exit")
            .expect("waiter task")
            .expect("watch registered");
    }
    watch
        .exited()
        .await
        .expect("an exited watch answers at once");
}

#[cfg(unix)]
#[test]
fn open_expecting_refuses_a_different_incarnation() {
    let pid = spawn_grandchild("600");
    let real = identity(pid).unwrap();
    let err = ProcWatch::open_expecting(pid, real.start + 1).expect_err("mismatch refused");
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    let ok = ProcWatch::open_expecting(pid, real.start).unwrap();
    ok.signal(Sig::Kill).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn identity_carries_the_process_name_and_never_its_arguments() {
    const SECRET: &str = "SYNTHETIC-SECRET-1234";
    let pid = spawn_grandchild_cmd(&format!("perl -e 'sleep 600' -- --token={SECRET}"));
    // Pin the incarnation first: whatever happens below, the cleanup kill can
    // only ever reach this process.
    let watch = ProcWatch::open(pid).expect("open the perl grandchild");
    // Between its fork and its exec the grandchild is still named `sh`; a
    // bounded wait for the exec keeps the assertion about the real name.
    let deadline = Instant::now() + Duration::from_secs(5);
    let seen = loop {
        let seen = identity(pid).expect("identity of a live process");
        if seen.name == "perl" || Instant::now() >= deadline {
            break seen;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    watch.signal(Sig::Kill).unwrap();
    assert_eq!(seen.name, "perl");
    assert_eq!(seen.pid, pid);
    let debug = format!("{seen:?}");
    let json = serde_json::to_string(&seen).unwrap();
    assert!(!debug.contains(SECRET), "Debug leaks argv: {debug}");
    assert!(!json.contains(SECRET), "JSON leaks argv: {json}");
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_fires_when_a_windows_process_exits() {
    let child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Milliseconds 400"])
        .spawn()
        .unwrap();
    let watch = ProcWatch::open(child.id()).unwrap();
    assert!(!watch.has_exited());
    tokio::time::timeout(Duration::from_secs(10), watch.exited())
        .await
        .expect("exit event")
        .expect("watch registered");
    assert!(watch.has_exited());
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_terminates_a_windows_process() {
    let child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 600"])
        .spawn()
        .unwrap();
    let watch = ProcWatch::open(child.id()).unwrap();
    watch.signal(Sig::Kill).unwrap();
    tokio::time::timeout(Duration::from_secs(10), watch.exited())
        .await
        .expect("killed")
        .expect("watch registered");
}
