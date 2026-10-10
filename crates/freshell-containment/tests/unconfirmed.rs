#![cfg(unix)]
//! Own test binary: it sets the process-wide test-hook environment (both
//! tests use the same values).
//!
//! The unconfirmed clock starts as the whole-unit kill (the last signal of
//! the sequence) ends. Before that the stop saves its record and, on the tag
//! backend, reads every process on the host more than once (before the soft
//! signal and in the kill), which takes as long as the host's load makes it:
//! under heavy load the kill ended 0.5 to 1.4 s later than at rest. So both
//! tests time the ERROR from the kill's own log line, never from the request.
mod support;

use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;
use tracing::Level;

/// Gone is held this long after the screen and main exit.
const HOLD_MS: u64 = 6500;

fn hold_gone_confirmation() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", HOLD_MS.to_string());
}

fn tag_unit() -> AgentUnit {
    let c = Containment::tag_backend(SelectOptions {
        shim: Some(test_shim()),
        ..Default::default()
    });
    c.create_unit(
        UnitId::mint(),
        UnitLabel {
            provider: "test".into(),
            ..Default::default()
        },
    )
    .unwrap()
}

/// Every captured event, as milliseconds after `t0`, for failure messages.
fn timeline(cap: &capture::Captured, t0: Instant) -> String {
    cap.0
        .lock()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{:>6} ms {} {} {:?}",
                e.at.saturating_duration_since(t0).as_millis(),
                e.level,
                e.event,
                e.fields
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn logged(
    cap: &capture::Captured,
    t0: Instant,
    level: Level,
    event: &str,
    fields: &[(&str, &str)],
) -> capture::Event {
    cap.first(level, event, fields).unwrap_or_else(|| {
        panic!(
            "{level} {event} {fields:?} was not logged:\n{}",
            timeline(cap, t0)
        )
    })
}

/// How late a due timer may fire: a wake-up delay, not a product tolerance.
/// Measured at 1 to 10 ms with 192 CPU-bound processes on garageserver's 96
/// cores (load average about 196); it stays under the hold's 1.5 s lead over
/// the ERROR, so a timer this late still logs before Gone.
const TIMER_LATENESS: Duration = Duration::from_secs(1);

/// The stop's first unconfirmed ERROR came `UNCONFIRMED_AFTER` after the
/// whole-unit kill (whose line is logged just before the clock starts), not
/// earlier and at most `TIMER_LATENESS` later, was the after-kill one, and
/// was logged while the stop was still unconfirmed: Gone followed it.
fn assert_unconfirmed_measured_from_the_kill(cap: &capture::Captured, t0: Instant) {
    let kill = logged(
        cap,
        t0,
        Level::INFO,
        "unit.stop.signal_sent",
        &[("signal", "SIGKILL"), ("target", "unit")],
    );
    let unconfirmed = logged(cap, t0, Level::ERROR, "unit.stop.unconfirmed", &[]);
    let gone = logged(cap, t0, Level::INFO, "unit.stop.gone", &[]);
    let after_kill = unconfirmed.at.checked_duration_since(kill.at);
    assert!(
        after_kill.is_some_and(|d| d >= UNCONFIRMED_AFTER),
        "unconfirmed is measured from the kill, not from the request \
         ({after_kill:?} after the kill):\n{}",
        timeline(cap, t0)
    );
    assert!(
        after_kill.is_some_and(|d| d < UNCONFIRMED_AFTER + TIMER_LATENESS),
        "unconfirmed is logged {UNCONFIRMED_AFTER:?} after the kill \
         ({after_kill:?} after the kill):\n{}",
        timeline(cap, t0)
    );
    assert_eq!(
        unconfirmed.fields["waiting_on"],
        "screen, main or lock",
        "{}",
        timeline(cap, t0)
    );
    assert!(
        unconfirmed.at < gone.at,
        "the ERROR is logged while the stop is unconfirmed, and the stop keeps waiting:\n{}",
        timeline(cap, t0)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn an_unconfirmed_stop_logs_an_error_at_five_seconds_and_keeps_waiting() {
    hold_gone_confirmation();
    let (cap, _guard) = capture::install();
    let unit = tag_unit();
    let s = agent_script(&AgentOpts {
        exit_on_int: true,
        ..Default::default()
    });
    let _child = spawn_main(&unit, &s).await;
    read_pids(&s).await;
    let t0 = Instant::now();
    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    // The agent exits at its SIGINT, the kill follows, and Gone comes at
    // least the hold later.
    let report = handle.wait().await;
    assert!(report.duration_ms >= HOLD_MS, "{}", timeline(&cap, t0));
    assert_unconfirmed_measured_from_the_kill(&cap, t0);
}

#[tokio::test(flavor = "current_thread")]
async fn an_escalated_graceful_stop_measures_unconfirmed_from_its_kill() {
    hold_gone_confirmation();
    let (cap, _guard) = capture::install();
    let unit = tag_unit();
    let s = agent_script(&AgentOpts::default()); // ignores SIGTERM
    let _child = spawn_main(&unit, &s).await;
    read_pids(&s).await;
    let grace = Duration::from_secs(2);
    let t0 = Instant::now();
    let handle = unit.stop(StopRequest::new(
        StopMode::Graceful { grace },
        StopReason::Cleanup,
        "cleanup",
    ));
    // The kill lands after the 2 s grace, Gone at least the hold later. An
    // unconfirmed clock started at the request (the earlier sketch) would log
    // its ERROR 5 s after the request, at most 3 s after this kill.
    let report = handle.wait().await;
    assert!(report.escalated);
    let escalated = logged(&cap, t0, Level::WARN, "unit.stop.escalated", &[]);
    let kill = logged(
        &cap,
        t0,
        Level::INFO,
        "unit.stop.signal_sent",
        &[("signal", "SIGKILL"), ("target", "unit")],
    );
    assert!(
        escalated.at <= kill.at && kill.at.duration_since(t0) >= grace,
        "the escalation, then the kill, after the grace:\n{}",
        timeline(&cap, t0)
    );
    assert_unconfirmed_measured_from_the_kill(&cap, t0);
}
