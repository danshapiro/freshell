//! A Codex pane's stop and the threads its app-server holds (Stage 2:
//! LB-51, LB-29).
//!
//! Gone checks the pane's own conversation lock even when the pane never
//! held an extra thread: a unit member holding it at the lock check is
//! killed, and its exit awaited, before Gone.
//!
//! The read of the threads the app-server holds, right before a stop's
//! first signal, is bounded and runs off the caller: when it is held up (a
//! Codex home on a hung network mount, here the containment's env-gated
//! hook), the stop signals anyway once the deadline passes, and WARN
//! `unit.threads.unchecked` says the threads could not be checked. Shift-X
//! (the connection's kill, which the connection's message loop handles) and
//! a registry kill (the synchronous stop path) both answer long before the
//! held-up read would finish.
//!
//! Own binary: it sets the env-gated hooks and installs a process-wide log
//! capture.
#![cfg(target_os = "linux")]
#[path = "../../freshell-containment/tests/support/capture.rs"]
#[allow(dead_code)]
mod capture;
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use unit_harness::{fake_codex, GoneDelay, HarnessOpts, ThreadReadHeldUp, UnitHarness};

/// How long the hook holds the read up: far past every bound below.
const HELD_UP_MS: u64 = 30_000;

/// One capture for the whole binary (each test filters by its terminal),
/// plus the [`GoneProbe`].
fn captured() -> capture::Captured {
    static CAPTURE: OnceLock<capture::Captured> = OnceLock::new();
    CAPTURE
        .get_or_init(|| {
            let cap = capture::Captured::default();
            let _ = tracing::subscriber::set_global_default(
                tracing_subscriber::registry()
                    .with(cap.clone())
                    .with(GoneProbe),
            );
            cap
        })
        .clone()
}

/// The process [`GoneProbe`] looks at, and the unit whose Gone it waits for.
static PROBED_PID: AtomicU32 = AtomicU32::new(0);
static PROBED_UNIT: Mutex<String> = Mutex::new(String::new());
/// Whether the probed process was still running when its unit's Gone was
/// logged (`None` until then).
static ALIVE_AT_GONE: Mutex<Option<bool>> = Mutex::new(None);

/// Reads, on the logging thread at the very moment the probed unit's
/// `unit.stop.gone` is logged, whether the probed process still runs.
struct GoneProbe;

#[derive(Default)]
struct GoneFields {
    event: Option<String>,
    unit_id: Option<String>,
}

impl Visit for GoneFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field.name(), value.to_string());
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.record(
            field.name(),
            format!("{value:?}").trim_matches('"').to_string(),
        );
    }
}

impl GoneFields {
    fn record(&mut self, name: &str, value: String) {
        match name {
            "event" => self.event = Some(value),
            "unit_id" => self.unit_id = Some(value),
            _ => {}
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for GoneProbe {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        let pid = PROBED_PID.load(Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        let mut fields = GoneFields::default();
        event.record(&mut fields);
        let unit = PROBED_UNIT.lock().unwrap().clone();
        if fields.event.as_deref() == Some("unit.stop.gone") && fields.unit_id == Some(unit) {
            *ALIVE_AT_GONE.lock().unwrap() = Some(fake_codex::pid_alive(pid));
        }
    }
}

/// Starts a member of the unit `placement` describes (as the containment
/// starts any member) that takes `lock` exclusively and keeps it; returns
/// once it holds the lock. Our own child: the test reaps it.
async fn member_holding(
    placement: &freshell_containment::Placement,
    lock: &std::path::Path,
) -> std::process::Child {
    const HOLD: &str = r#"use Fcntl qw(:flock);
open(my $f, ">>", $ARGV[0]) or die "open: $!";
flock($f, LOCK_EX) or die "flock: $!";
$| = 1;
print "locked\n";
sleep 600;"#;
    let mut command = match placement.wrapper.as_deref() {
        Some([program, args @ ..]) => {
            let mut command = std::process::Command::new(program);
            command.args(args).arg("perl");
            command
        }
        _ => std::process::Command::new("perl"),
    };
    let mut child = command
        .args(["-e", HOLD])
        .arg(lock)
        .envs(placement.env.iter().map(|(k, v)| (k, v)))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("start the member");
    let stdout = child.stdout.take().expect("its stdout");
    let line = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).map(|_| line)
        }),
    )
    .await
    .expect("the member takes the lock in time")
    .expect("read its answer")
    .expect("its answer");
    assert_eq!(line.trim(), "locked", "the member took the lock");
    child
}

/// The native app-server manifest of process `pid` (readable after it died).
fn native_manifest(h: &UnitHarness, pid: u32) -> fake_codex::NativeManifest {
    let raw = std::fs::read_to_string(h.manifests.join(format!("native-{pid}.json")))
        .expect("the native's manifest");
    serde_json::from_str(&raw).expect("native manifest JSON")
}

/// The WARN that the threads could not be checked, naming the pane's unit.
async fn unchecked_warning(
    cap: &capture::Captured,
    tid: &str,
    unit_id: &str,
    session_id: &str,
) -> capture::Event {
    let warning = cap
        .wait_for(
            tracing::Level::WARN,
            "unit.threads.unchecked",
            &[("terminal_id", tid)],
            Duration::from_secs(5),
        )
        .await
        .expect("WARN unit.threads.unchecked for the pane");
    for (key, value) in [
        ("unit_id", unit_id),
        ("provider", "codex"),
        ("session_id", session_id),
    ] {
        assert_eq!(
            warning.fields.get(key).map(String::as_str),
            Some(value),
            "{key}: {warning:?}"
        );
    }
    warning
}

#[tokio::test(flavor = "multi_thread")]
async fn gone_waits_for_a_member_holding_the_panes_own_conversation_lock() {
    let cap = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-own", Some("t-own")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI resumed its conversation");
    assert!(fake_codex::holds_lock_fd(
        h.native_pid(&tid),
        &h.lock("t-own")
    ));
    let unit = h.unit_for(&tid);
    let unit_id = unit.id().as_str().to_string();
    // How a member joins this unit, asked while it still runs.
    let placement = unit
        .placement(freshell_containment::MemberRole::Agent)
        .expect("a placement");
    // Gone waits a while after the whole-unit kill, before its lock check.
    let _delay = GoneDelay::set(3000);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-own", "createRequestId": "crq-own"}),
    )
    .await;
    cap.wait_for(
        tracing::Level::INFO,
        "unit.stop.signal_sent",
        &[
            ("unit_id", &unit_id),
            ("signal", "SIGKILL"),
            ("target", "unit"),
        ],
        Duration::from_secs(10),
    )
    .await
    .expect("the whole unit is killed");
    // A member that joined after the kill takes the pane's own conversation
    // lock (free once the killed app-server is gone).
    let mut member = member_holding(&placement, &h.lock("t-own")).await;
    *PROBED_UNIT.lock().unwrap() = unit_id.clone();
    PROBED_PID.store(member.id(), Ordering::SeqCst);

    let killed = h
        .next_matching(&mut ws, Duration::from_secs(15), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-own"
        })
        .await
        .expect("the kill is answered");
    PROBED_PID.store(0, Ordering::SeqCst);
    assert_eq!(killed["success"], true, "{killed}");
    assert_eq!(
        *ALIVE_AT_GONE.lock().unwrap(),
        Some(false),
        "the member holding the pane's own conversation lock was killed, and its exit awaited, before Gone"
    );
    assert!(!fake_codex::lock_held(&h.lock("t-own")));
    let _ = member.kill();
    let _ = member.wait();
}

#[tokio::test(flavor = "multi_thread")]
async fn shift_x_signals_while_the_thread_read_is_held_up() {
    let cap = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h
        .create_codex(&mut ws, "crq-held-up", Some("t-held-up"))
        .await;
    let unit_id = h.unit_for(&tid).id().as_str().to_string();
    let native = h.native_pid(&tid);
    let _held_up = ThreadReadHeldUp::set(HELD_UP_MS);

    let asked = Instant::now();
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk-held-up", "createRequestId": "crq-held-up"}),
    )
    .await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-held-up"
        })
        .await
        .expect("Shift-X is answered while the read is still held up");
    assert_eq!(killed["success"], true, "{killed}");
    assert!(asked.elapsed() < Duration::from_millis(HELD_UP_MS));
    unchecked_warning(&cap, &tid, &unit_id, "t-held-up").await;
    assert!(
        native_manifest(&h, native)
            .signals
            .iter()
            .any(|signal| signal.sig == "SIGINT"),
        "the agent main process got its SIGINT"
    );
    assert!(!fake_codex::lock_held(&h.lock("t-held-up")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_registry_kill_is_not_held_up_by_the_thread_read() {
    let cap = captured();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-reg", Some("t-reg")).await;
    let unit_id = h.unit_for(&tid).id().as_str().to_string();
    let _held_up = ThreadReadHeldUp::set(HELD_UP_MS);

    // The registry's kill of a unit row (an idle reap, a handoff) starts the
    // unit's stop synchronously, on the caller's thread.
    let registry = h.state.registry.clone();
    let row = tid.clone();
    let asked = Instant::now();
    let stopped = tokio::task::spawn_blocking(move || registry.kill(&row))
        .await
        .expect("the kill ran");
    assert!(stopped, "the unit row's kill starts its unit's stop");
    assert!(
        asked.elapsed() < Duration::from_secs(10),
        "the stop began without waiting for the held-up read: {:?}",
        asked.elapsed()
    );
    unchecked_warning(&cap, &tid, &unit_id, "t-reg").await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()
    })
    .await
    .expect("the pane reaches Gone");
}
