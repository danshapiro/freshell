#![cfg(unix)]
//! Own test binary: it sets the process-wide test-hook environment (both
//! tests use the same values).
mod support;

use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;

fn hold_gone_confirmation() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", "6500");
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
    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    assert!(
        handle.wait_for(Duration::from_secs(5)).await.is_none(),
        "not Gone within 5 s"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"));
    let report = handle.wait().await;
    assert!(report.duration_ms >= 6500);
    assert!(cap.has(tracing::Level::INFO, "unit.stop.gone"));
}

#[tokio::test(flavor = "current_thread")]
async fn an_escalated_graceful_stop_measures_unconfirmed_from_its_kill() {
    hold_gone_confirmation();
    let (cap, _guard) = capture::install();
    let unit = tag_unit();
    let s = agent_script(&AgentOpts::default()); // ignores SIGTERM
    let _child = spawn_main(&unit, &s).await;
    read_pids(&s).await;
    let t0 = Instant::now();
    let handle = unit.stop(StopRequest::new(
        StopMode::Graceful {
            grace: Duration::from_secs(2),
        },
        StopReason::Cleanup,
        "cleanup",
    ));
    // The kill lands at about 2 s, Gone at about 8.5 s (2 s + the 6.5 s hold).
    assert!(handle
        .wait_for(Duration::from_millis(5500).saturating_sub(t0.elapsed()))
        .await
        .is_none());
    assert!(cap.has(tracing::Level::WARN, "unit.stop.escalated"));
    assert!(
        !cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"),
        "unconfirmed is measured from the kill, not from the request"
    );
    assert!(handle
        .wait_for(Duration::from_millis(7300).saturating_sub(t0.elapsed()))
        .await
        .is_none());
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"));
    let report = handle.wait().await;
    assert!(report.escalated);
}
