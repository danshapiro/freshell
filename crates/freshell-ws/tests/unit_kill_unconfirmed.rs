//! A Shift-X whose Gone is not confirmed within 5 s: the unit stays
//! Stopping (its persisted record too), ERROR `unit.stop.unconfirmed` is
//! logged, no acknowledgement is sent (the tab stays open showing
//! "Stopping…"), and the kill is acknowledged once Gone is confirmed. Own
//! binary: it holds Gone through the env-gated test hook and installs a
//! process-wide log capture.
#![cfg(target_os = "linux")]
#[path = "../../freshell-containment/tests/support/capture.rs"]
#[allow(dead_code)]
mod capture;
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use tracing_subscriber::prelude::*;
use unit_harness::{HarnessOpts, UnitHarness};

/// The unit records under the harness's state root.
fn unit_records(h: &UnitHarness) -> Vec<serde_json::Value> {
    std::fs::read_dir(h.home.path().join(".freshell").join("units"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unconfirmed_stop_keeps_stopping_logs_an_error_and_acks_when_gone() {
    let cap = capture::Captured::default();
    let _ =
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(cap.clone()));
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-u", Some("t-u")).await;
    // The start stops its unused base unit without waiting for it, and the
    // Gone hold below applies to every stop that has not confirmed yet. So
    // first wait for each other recorded unit's Gone: then the hold applies
    // only to the pane's own stop, and its record is the only one left.
    let pane_unit = h.unit_for(&tid).id().as_str().to_string();
    for record in unit_records(&h) {
        let unit_id = record["unit_id"].as_str().expect("a unit id").to_string();
        if unit_id == pane_unit {
            continue;
        }
        cap.wait_for(
            tracing::Level::INFO,
            "unit.stop.gone",
            &[("unit_id", &unit_id)],
            Duration::from_secs(10),
        )
        .await
        .unwrap_or_else(|| panic!("the start's other unit reaches Gone: {record}"));
    }
    // Gone is held 8 s past the kill; UNCONFIRMED_AFTER (5 s) is measured
    // from the last signal, so the ERROR comes first.
    let _delay = unit_harness::GoneDelay::set(8000);
    h.send(
        &mut ws,
        json!({"type": "terminal.kill", "terminalId": tid, "requestId": "ru", "createRequestId": "crq-u"}),
    )
    .await;
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(6), |f| f["type"]
            == "terminal.killed")
            .await
            .is_none(),
        "no ack before Gone"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    while !cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "ERROR unit.stop.unconfirmed is logged 5 s after the kill"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let ownership = h.state.ownership.as_ref().unwrap();
    let operation = match ownership.observe("codex", "t-u").state {
        freshell_ownership::OwnershipState::Stopping { operation_id, .. } => operation_id,
        other => panic!("the conversation stays Stopping until Gone: {other:?}"),
    };
    let records = unit_records(&h);
    assert_eq!(records.len(), 1, "the pane's unit record: {records:?}");
    assert_eq!(records[0]["state"]["kind"], "stopping", "{}", records[0]);
    assert_eq!(
        records[0]["state"]["operation_id"], operation,
        "persisted Stopping names the kill's operation: {}",
        records[0]
    );

    let f = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "ru"
        })
        .await
        .expect("ack at Gone");
    assert_eq!(f["success"], true);
    assert_eq!(
        ownership.observe("codex", "t-u").state,
        freshell_ownership::OwnershipState::Vacant
    );
    assert!(
        unit_records(&h).is_empty(),
        "the unit record is deleted at Gone"
    );
}
