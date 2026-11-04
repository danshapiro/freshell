//! OpenCode configuration settings are reported only after the production
//! pane ledger accepts the durable update.

mod common;

use common::ledger_sink::LedgerSink;
use freshell_freshagent::{
    FreshAgentBindingUpsert, FreshAgentSettings, FreshAgentState, GenesisUpdate, PaneIdentitySink,
    ProvenanceUpdate, SettingsUpdate,
};
use freshell_ws::pane_ledger::{PaneLedger, RowState};
use serde_json::{json, Value};
use std::sync::Arc;

fn drain_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        frames.push(serde_json::from_str(&frame).expect("broadcast frames are JSON"));
    }
    frames
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_materialized_configure_keeps_both_views_memory_and_reloaded_ledger_unchanged() {
    let root = tempfile::tempdir().expect("create ledger root");
    let ledger_path = root.path().join("pane-ledger");
    let ledger = Arc::new(PaneLedger::new(Some(ledger_path.clone())));
    let session_id = "ses-configure-write-failure";
    let old_settings = FreshAgentSettings {
        model: Some("provider/model-before".into()),
        effort: Some("high".into()),
        ..FreshAgentSettings::default()
    };
    let seed_sink = LedgerSink::new(Arc::clone(&ledger));
    seed_sink
        .record_binding(FreshAgentBindingUpsert {
            genesis: GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: session_id.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(old_settings.clone()),
        })
        .await
        .expect("seed the last saved settings in the real ledger");

    let (broadcast_tx, mut first_view) = tokio::sync::broadcast::channel::<String>(32);
    let mut second_view = broadcast_tx.subscribe();
    let fresh_agent =
        FreshAgentState::new(Arc::new("test-token".to_string()), Arc::new(broadcast_tx));
    let state = freshell_freshagent::FreshOpencodeState::new(fresh_agent);
    state.set_identity_sink(Arc::new(
        LedgerSink::new(Arc::clone(&ledger)).with_binding_write_failure(),
    ));
    state
        .insert_materialized_session_for_test(
            session_id,
            old_settings.model.as_deref(),
            old_settings.effort.as_deref(),
        )
        .await;

    let configure = serde_json::from_value(json!({
        "provider": "opencode",
        "sessionId": session_id,
        "sessionType": "freshopencode",
        "requestId": "configure-write-failure",
        "settings": { "model": "provider/model-after", "effort": "low" },
    }))
    .expect("configure frame has the protocol shape");
    state.handle_configure(configure).await;

    let first_frames = drain_frames(&mut first_view);
    let second_frames = drain_frames(&mut second_view);
    for frames in [&first_frames, &second_frames] {
        assert!(
            !frames.iter().any(|frame| {
                frame["event"]["type"] == "freshAgent.session.metadata"
            }),
            "a failed durable write must not tell this view the new settings were saved: {frames:?}"
        );
        let error = frames
            .iter()
            .find(|frame| frame["event"]["type"] == "freshAgent.error")
            .expect("each view receives the shared failure event");
        assert_eq!(error["event"]["code"], "LEDGER_WRITE_FAILED");
        assert_eq!(
            error["event"]["requestId"], "configure-write-failure",
            "the error is correlated to the configuring view's request"
        );
    }
    assert_eq!(
        state.session_settings_for_test(session_id).await,
        Some((old_settings.model.clone(), old_settings.effort.clone())),
        "the in-memory OpenCode session keeps the previous settings"
    );
    assert_eq!(
        ledger
            .load_binding("opencode", session_id)
            .expect("the old durable row remains present")
            .state,
        RowState::Bound
    );

    drop(state);
    drop(seed_sink);
    drop(ledger);
    let reloaded = PaneLedger::new(Some(ledger_path));
    let row = reloaded
        .load_binding("opencode", session_id)
        .expect("the durable row reloads after the failed update");
    assert_eq!(row.model.as_deref(), Some("provider/model-before"));
    assert_eq!(row.effort.as_deref(), Some("high"));
}
