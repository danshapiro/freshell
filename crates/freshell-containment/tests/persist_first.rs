#![cfg(target_os = "linux")]
//! Own test binary: it sets the process-wide test-hook environment.
mod support;

use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;

#[tokio::test(flavor = "current_thread")]
async fn no_signal_is_sent_until_stopping_is_saved() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_PERSIST_DELAY_MS", "3000");
    let (cap, _guard) = capture::install();
    let root = tempfile::tempdir().unwrap();
    let c = rebuild("tag", root.path());
    let unit = c
        .create_unit(
            UnitId::mint(),
            UnitLabel {
                provider: "test".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let path = record_path(root.path(), "tag", &unit);
    let s = agent_script(&AgentOpts {
        exit_on_int: true,
        on_int_copy: Some(path.clone()),
        ..Default::default()
    });
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;

    let t0 = Instant::now();
    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    assert!(handle.wait_for(Duration::from_secs(2)).await.is_none());
    assert!(
        alive(p.main),
        "the agent is untouched while Stopping is being saved"
    );
    assert!(!s.marker.exists(), "no SIGINT before Stopping is saved");
    handle.wait().await;
    assert!(
        t0.elapsed() >= Duration::from_secs(3),
        "Gone came before the slow write finished: {:?}",
        t0.elapsed()
    );
    let at_signal: UnitRecord =
        serde_json::from_slice(&std::fs::read(s.at_signal()).unwrap()).unwrap();
    assert!(
        matches!(&at_signal.state, UnitRecordState::Stopping { reason, .. } if reason == "shift-x"),
        "{at_signal:?}"
    );
    assert!(
        !cap.has(tracing::Level::ERROR, "unit.stop.persist_failed"),
        "a slow write is not a failure"
    );
    assert!(!path.exists(), "the record is deleted at Gone");
}
