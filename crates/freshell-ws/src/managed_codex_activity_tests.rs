use super::*;
use freshell_activity::codex::{CodexActivityBatch, CodexActivityEvent};

fn managed() -> ActivityHub {
    let (tx, _) = tokio::sync::broadcast::channel(32);
    let hub = ActivityHub::new(Arc::new(tx), None);
    (hub.registry_observer())(ActivityEvent::Created {
        terminal_id: "managed-codex".into(),
        mode: "codex".into(),
        resume_session_id: Some("thread-owned".into()),
        at: now_ms(),
    });
    hub
}

fn turn(seq: u64, id: &str, status: Option<&str>) -> CodexActivityEvent {
    CodexActivityEvent {
        seq,
        at: seq as i64 + 100,
        thread_id: "thread-owned".into(),
        turn_id: Some(id.into()),
        status: status.map(str::to_string),
        completed: status.is_some(),
    }
}

fn send(hub: &ActivityHub, epoch: &str, events: Vec<CodexActivityEvent>) {
    hub.note_managed_codex_activity(
        "managed-codex",
        epoch,
        Some("thread-owned"),
        CodexActivityBatch {
            retained_from_seq: events.first().unwrap().seq,
            head_seq: events.last().unwrap().seq,
            events,
        },
    );
}

async fn flush(hub: &ActivityHub) {
    let (ack, done) = tokio::sync::oneshot::channel();
    hub.tx.send(HubEvent::Barrier(ack)).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), done)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn managed_codex_one_read_completes_each_distinct_native_turn() {
    let hub = managed();
    send(
        &hub,
        "epoch",
        vec![
            turn(1, "first", None),
            turn(2, "first", Some("completed")),
            turn(3, "second", None),
            turn(4, "second", Some("completed")),
        ],
    );
    let mut frames = hub.broadcast_tx.subscribe();
    flush(&hub).await;
    let completions: Vec<serde_json::Value> = std::iter::from_fn(|| frames.try_recv().ok())
        .map(|frame| serde_json::from_str::<serde_json::Value>(&frame).unwrap())
        .filter(|frame| frame["type"] == "terminal.turn.complete")
        .collect();
    assert_eq!(
        completions.len(),
        2,
        "batching must not make separate native turns share a completion key"
    );
    assert_eq!(completions[0]["completionSeq"], 1);
    assert_eq!(completions[1]["completionSeq"], 2);
}

#[tokio::test]
async fn managed_codex_lost_native_prefix_cannot_complete_a_stale_busy_turn() {
    let hub = managed();
    send(&hub, "epoch", vec![turn(1, "old-turn", None)]);
    flush(&hub).await;
    assert_eq!(
        hub.inner.lock().unwrap().codex.list()[0].phase,
        freshell_protocol::CodexPhase::Busy
    );
    send(&hub, "epoch", vec![turn(3, "old-turn", Some("completed"))]);
    flush(&hub).await;
    let inner = hub.inner.lock().unwrap();
    assert_eq!(
        inner.codex.list()[0].phase,
        freshell_protocol::CodexPhase::Idle
    );
    assert!(inner.codex.list_latest_completions().is_empty());
}

#[tokio::test]
async fn managed_codex_new_source_restarts_its_cursor_and_ignores_foreign_turns() {
    let hub = managed();
    let mut frames = hub.broadcast_tx.subscribe();
    send(&hub, "old-epoch", vec![turn(1, "old-turn", None)]);
    let mut foreign = turn(1, "foreign-turn", Some("completed"));
    foreign.thread_id = "foreign-thread".into();
    send(
        &hub,
        "new-epoch",
        vec![
            foreign,
            turn(2, "new-turn", None),
            turn(3, "new-turn", Some("completed")),
        ],
    );
    flush(&hub).await;
    let completions = hub.inner.lock().unwrap().codex.list_latest_completions();
    assert_eq!(completions.len(), 1);
    let completion = std::iter::from_fn(|| frames.try_recv().ok())
        .map(|frame| serde_json::from_str::<serde_json::Value>(&frame).unwrap())
        .find(|frame| frame["type"] == "terminal.turn.complete")
        .unwrap();
    assert_eq!(completion["sessionId"], "thread-owned");
    assert_eq!(completion["outcome"], "completed");
}

#[tokio::test]
async fn managed_codex_failed_turns_remain_failed_and_human_interruptions_stay_silent() {
    for (status, expected) in [("failed", Some("failed")), ("interrupted", None)] {
        let hub = managed();
        let mut frames = hub.broadcast_tx.subscribe();
        send(
            &hub,
            "epoch",
            vec![turn(1, "turn", None), turn(2, "turn", Some(status))],
        );
        flush(&hub).await;
        let inner = hub.inner.lock().unwrap();
        let completion = std::iter::from_fn(|| frames.try_recv().ok())
            .map(|frame| serde_json::from_str::<serde_json::Value>(&frame).unwrap())
            .find(|frame| frame["type"] == "terminal.turn.complete");
        assert_eq!(
            completion
                .as_ref()
                .and_then(|frame| frame["outcome"].as_str()),
            expected
        );
        assert_eq!(
            inner.codex.list()[0].phase,
            freshell_protocol::CodexPhase::Idle
        );
    }
}
