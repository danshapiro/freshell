use super::*;
use freshell_activity::opencode::{OpencodeActivityBatch, OpencodeActivityEvent};

fn batch(events: Vec<OpencodeLaneEvent>) -> OpencodeActivityBatch {
    OpencodeActivityBatch {
        retained_from_seq: 1,
        head_seq: events.len() as u64,
        events: events
            .into_iter()
            .enumerate()
            .map(|(index, event)| OpencodeActivityEvent {
                seq: index as u64 + 1,
                at: now_ms(),
                cycle: 1,
                stream: 1,
                event,
            })
            .collect(),
    }
}

fn status(status: OpencodeStatus) -> OpencodeLaneEvent {
    OpencodeLaneEvent::Status {
        session_id: "ses_native".into(),
        status,
    }
}

async fn flush(hub: &ActivityHub) {
    let (ack, done) = tokio::sync::oneshot::channel();
    hub.tx.send(HubEvent::Barrier(ack)).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), done)
        .await
        .unwrap()
        .unwrap();
}

fn managed() -> ActivityHub {
    let (tx, _frames) = tokio::sync::broadcast::channel(32);
    let hub = ActivityHub::new(Arc::new(tx), None);
    (hub.registry_observer())(ActivityEvent::Created {
        terminal_id: "managed-native".into(),
        mode: "opencode".into(),
        resume_session_id: Some("ses_native".into()),
        at: now_ms(),
    });
    hub
}

fn send(hub: &ActivityHub, epoch: &str, native: OpencodeActivityBatch) {
    hub.note_managed_opencode_activity("managed-native", epoch, Some("ses_native"), native);
}

#[tokio::test]
async fn managed_native_busy_and_idle_emit_activity_and_exactly_one_completion() {
    let (tx, mut frames) = tokio::sync::broadcast::channel(32);
    let hub = ActivityHub::new(Arc::new(tx), None);
    (hub.registry_observer())(ActivityEvent::Created {
        terminal_id: "managed-native".into(),
        mode: "opencode".into(),
        resume_session_id: Some("ses_native".into()),
        at: now_ms(),
    });
    let native = batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]);
    hub.note_managed_opencode_activity(
        "managed-native",
        "owned-epoch",
        Some("ses_native"),
        native.clone(),
    );
    let mut saw_busy = false;
    let completion = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame: serde_json::Value =
                serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
            if frame["type"] == "opencode.activity.updated"
                && frame["upsert"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty())
            {
                saw_busy = true;
            }
            if frame["type"] == "terminal.turn.complete" {
                break frame;
            }
        }
    })
    .await
    .expect("native busy/idle must complete the managed terminal turn");
    assert!(saw_busy);
    assert_eq!(completion["outcome"], "completed");
    assert_eq!(completion["sessionId"], "ses_native");
    assert_eq!(completion["completionSeq"], 1);
    hub.note_managed_opencode_activity("managed-native", "owned-epoch", Some("ses_native"), native);
    flush(&hub).await;
    assert!(
        frames.try_recv().is_err(),
        "repeated host metadata cannot duplicate completion"
    );
}

#[tokio::test]
async fn managed_provider_error_fails_and_abort_never_reports_success() {
    for (error_name, expected) in [
        ("ProviderError", Some("failed")),
        ("MessageAbortedError", None),
    ] {
        let hub = managed();
        let mut frames = hub.broadcast_tx.subscribe();
        send(
            &hub,
            "epoch",
            batch(vec![
                status(OpencodeStatus::Busy),
                OpencodeLaneEvent::SessionError {
                    session_id: "ses_native".into(),
                    error_name: error_name.into(),
                },
                status(OpencodeStatus::Idle),
            ]),
        );
        flush(&hub).await;
        let inner = hub.inner.lock().unwrap();
        assert!(inner.opencode.list().is_empty());
        let mut actual = None;
        while let Ok(frame) = frames.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if frame["type"] == "terminal.turn.complete" {
                actual = frame["outcome"].as_str().map(str::to_string);
            }
        }
        assert_eq!(actual.as_deref(), expected);
    }
}

#[tokio::test]
async fn lost_native_event_prefix_cannot_turn_a_missing_error_into_success() {
    let hub = managed();
    send(&hub, "epoch", batch(vec![status(OpencodeStatus::Busy)]));
    flush(&hub).await;
    assert_eq!(hub.inner.lock().unwrap().opencode.list().len(), 1);
    send(
        &hub,
        "epoch",
        OpencodeActivityBatch {
            retained_from_seq: 3,
            head_seq: 3,
            events: vec![OpencodeActivityEvent {
                seq: 3,
                at: now_ms(),
                cycle: 1,
                stream: 1,
                event: status(OpencodeStatus::Idle),
            }],
        },
    );
    flush(&hub).await;
    let inner = hub.inner.lock().unwrap();
    assert!(inner.opencode.list().is_empty());
    assert!(inner.opencode.list_latest_completions().is_empty());
}

#[tokio::test]
async fn new_native_source_epoch_clears_stale_busy_and_restarts_metadata_sequences() {
    let hub = managed();
    send(&hub, "old-epoch", batch(vec![status(OpencodeStatus::Busy)]));
    send(&hub, "new-epoch", batch(vec![status(OpencodeStatus::Idle)]));
    flush(&hub).await;
    assert!(hub
        .inner
        .lock()
        .unwrap()
        .opencode
        .list_latest_completions()
        .is_empty());
    send(
        &hub,
        "new-epoch",
        batch(vec![
            status(OpencodeStatus::Idle),
            status(OpencodeStatus::Busy),
            status(OpencodeStatus::Idle),
        ]),
    );
    flush(&hub).await;
    let inner = hub.inner.lock().unwrap();
    assert!(inner.opencode.list().is_empty());
    assert_eq!(inner.opencode.list_latest_completions().len(), 1);
}

#[tokio::test]
async fn native_root_mapping_preserves_child_permission_pause_and_resume() {
    let hub = managed();
    let mut events = vec![
        OpencodeLaneEvent::SessionCreated {
            session_id: "ses_native".into(),
            parent_id: None,
        },
        OpencodeLaneEvent::SessionCreated {
            session_id: "ses_child".into(),
            parent_id: Some("ses_native".into()),
        },
        status(OpencodeStatus::Busy),
        OpencodeLaneEvent::PermissionAsked {
            session_id: "ses_child".into(),
            permission_id: "per_native".into(),
        },
    ];
    send(&hub, "epoch", batch(events.clone()));
    flush(&hub).await;
    assert!(
        hub.inner.lock().unwrap().opencode.list().is_empty(),
        "native ask pauses the busy light"
    );
    assert!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .is_empty(),
        "a pause is not completion"
    );
    events.push(OpencodeLaneEvent::PermissionReplied {
        permission_id: "per_native".into(),
    });
    send(&hub, "epoch", batch(events.clone()));
    flush(&hub).await;
    assert_eq!(hub.inner.lock().unwrap().opencode.list().len(), 1);
    events.push(status(OpencodeStatus::Idle));
    send(&hub, "epoch", batch(events));
    flush(&hub).await;
    assert_eq!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .len(),
        1
    );
}

#[tokio::test]
async fn native_status_proves_turn_identity_and_output_alone_cannot_complete_it() {
    let hub = managed();
    (hub.registry_observer())(ActivityEvent::Output {
        terminal_id: "managed-native".into(),
        data: "synthetic-repaint".into(),
        at: now_ms(),
    });
    flush(&hub).await;
    assert!(hub
        .inner
        .lock()
        .unwrap()
        .opencode
        .list_latest_completions()
        .is_empty());
    hub.note_managed_opencode_activity(
        "managed-native",
        "epoch",
        None,
        batch(vec![
            status(OpencodeStatus::Busy),
            status(OpencodeStatus::Idle),
        ]),
    );
    flush(&hub).await;
    assert_eq!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .len(),
        1,
        "the native root from this pane's private lane is itself identity proof"
    );
    hub.bind_opencode_session("managed-native", "ses_native");
    flush(&hub).await;
    assert_eq!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .len(),
        1
    );
}

#[tokio::test]
async fn invalid_native_sequences_and_post_exit_events_are_inert() {
    let hub = managed();
    let mut invalid = batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]);
    invalid.events[1].seq = 1;
    send(&hub, "epoch", invalid);
    (hub.registry_observer())(ActivityEvent::Exit {
        terminal_id: "managed-native".into(),
        at: now_ms(),
        spontaneous: false,
    });
    send(
        &hub,
        "epoch",
        batch(vec![
            status(OpencodeStatus::Busy),
            status(OpencodeStatus::Idle),
        ]),
    );
    flush(&hub).await;
    let inner = hub.inner.lock().unwrap();
    assert!(inner.opencode.list_latest_completions().is_empty());
    assert!(!inner
        .managed_opencode_cursors
        .contains_key("managed-native"));
}

fn historical(mut native: OpencodeActivityBatch) -> OpencodeActivityBatch {
    for event in &mut native.events {
        event.at = now_ms() - 60_000;
    }
    native
}

#[tokio::test]
async fn historical_unbound_permission_end_does_not_ring_on_spontaneous_exit() {
    let (tx, mut frames) = tokio::sync::broadcast::channel(32);
    let hub = ActivityHub::new(Arc::new(tx), None);
    (hub.registry_observer())(ActivityEvent::Created {
        terminal_id: "managed-native".into(),
        mode: "opencode".into(),
        resume_session_id: None,
        at: now_ms(),
    });
    hub.note_managed_opencode_activity(
        "managed-native",
        "surviving-host",
        None,
        historical(batch(vec![
            OpencodeLaneEvent::Snapshot {
                statuses: vec![("ses_native".into(), OpencodeStatus::Busy)],
            },
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses_native".into(),
                permission_id: "finished-permission".into(),
            },
            status(OpencodeStatus::Idle),
        ])),
    );
    flush(&hub).await;
    (hub.registry_observer())(ActivityEvent::Exit {
        terminal_id: "managed-native".into(),
        at: now_ms(),
        spontaneous: true,
    });
    flush(&hub).await;
    for frame in std::iter::from_fn(|| frames.try_recv().ok()) {
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_ne!(
            frame["type"], "terminal.idle",
            "an ended historical permission must not engage a later exit: {frame}"
        );
        assert_ne!(frame["type"], "terminal.turn.complete");
    }
}

#[tokio::test]
async fn historical_native_completion_is_silent_but_later_live_turn_still_completes() {
    let hub = managed();
    let mut frames = hub.broadcast_tx.subscribe();
    let old = historical(batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]));
    send(&hub, "surviving-host", old.clone());
    flush(&hub).await;
    hub.expire_due();
    flush(&hub).await;
    assert!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .is_empty(),
        "retained completion before this hub started must not become new attention"
    );
    while let Ok(frame) = frames.try_recv() {
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_ne!(frame["type"], "terminal.turn.complete");
        assert_ne!(frame["type"], "terminal.idle");
    }
    let mut live = batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]);
    live.events[..2].clone_from_slice(&old.events);
    send(&hub, "surviving-host", live.clone());
    flush(&hub).await;
    assert_eq!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .len(),
        1
    );
    send(&hub, "surviving-host", live);
    flush(&hub).await;
    let completions = std::iter::from_fn(|| frames.try_recv().ok())
        .map(|frame| serde_json::from_str::<serde_json::Value>(&frame).unwrap())
        .filter(|frame| frame["type"] == "terminal.turn.complete")
        .count();
    assert_eq!(
        completions, 1,
        "live turn completes once after historical prefix consumption"
    );
}

#[tokio::test]
async fn historical_busy_and_permission_state_survives_until_live_resume_and_completion() {
    let hub = managed();
    send(
        &hub,
        "surviving-host",
        historical(batch(vec![
            status(OpencodeStatus::Busy),
            OpencodeLaneEvent::PermissionAsked {
                session_id: "ses_native".into(),
                permission_id: "pending".into(),
            },
        ])),
    );
    flush(&hub).await;
    assert!(hub
        .inner
        .lock()
        .unwrap()
        .opencode
        .has_pending_permissions("managed-native"));
    assert!(hub
        .inner
        .lock()
        .unwrap()
        .opencode
        .list_latest_completions()
        .is_empty());
    let next = batch(vec![
        status(OpencodeStatus::Busy),
        OpencodeLaneEvent::PermissionAsked {
            session_id: "ses_native".into(),
            permission_id: "pending".into(),
        },
        OpencodeLaneEvent::PermissionReplied {
            permission_id: "pending".into(),
        },
        status(OpencodeStatus::Idle),
    ]);
    send(&hub, "surviving-host", next);
    flush(&hub).await;
    assert_eq!(
        hub.inner
            .lock()
            .unwrap()
            .opencode
            .list_latest_completions()
            .len(),
        1
    );
}

#[tokio::test]
async fn first_native_read_preserves_a_new_turn_after_a_historical_prefix() {
    let hub = managed();
    let mut frames = hub.broadcast_tx.subscribe();
    let old = historical(batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]));
    let mut mixed = batch(vec![
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
        status(OpencodeStatus::Busy),
        status(OpencodeStatus::Idle),
    ]);
    mixed.events[..2].clone_from_slice(&old.events);
    send(&hub, "surviving-host", mixed);
    flush(&hub).await;
    let completed: Vec<_> = std::iter::from_fn(|| frames.try_recv().ok())
        .map(|frame| serde_json::from_str::<serde_json::Value>(&frame).unwrap())
        .filter(|frame| frame["type"] == "terminal.turn.complete")
        .collect();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0]["completionSeq"], 1);
    assert_eq!(completed[0]["outcome"], "completed");
}
