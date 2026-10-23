//! Pending-set transitions must reflect each mutation atomically. A response can
//! remove the last approval while the stdout consumer receives the next one.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn responding_while_new_requests_arrive_preserves_every_waiting_transition() {
    let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
    let done = Arc::new(AtomicBool::new(false));
    let start = Arc::new(std::sync::Barrier::new(2));
    let producer = {
        let pending = pending.clone();
        let done = done.clone();
        let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            let mut waiting = 0usize;
            for _ in 0..20_000 {
                let change = fold_pending_frame(
                    &pending,
                    &json!({
                        "type": "sdk.permission.request", "requestId": "approval",
                        "tool": {"name": "Bash", "input": {"command": "ls"}},
                    }),
                );
                waiting += usize::from(change == Some(PendingChange::Waiting));
            }
            done.store(true, Ordering::Release);
            waiting
        })
    };
    start.wait();
    let mut drained = 0usize;
    while !done.load(Ordering::Acquire) {
        let mut current = pending.lock().unwrap();
        if current.len() != 0 {
            // The response handler's successful write removes its pending card.
            current.permissions.clear();
            drained += 1;
        }
        drop(current);
        std::thread::yield_now();
    }
    let waiting = producer.join().unwrap();
    let remaining = usize::from(pending.lock().unwrap().len() != 0);
    assert_eq!(
        waiting,
        drained + remaining,
        "every new nonempty pending interval needs exactly one waiting edge"
    );
    assert!(drained > 0, "the responder must have run concurrently");
}

#[test]
fn an_answered_approval_followed_by_a_question_starts_a_new_waiting_interval() {
    let pending = std::sync::Mutex::new(ClaudePending::default());
    assert_eq!(
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.permission.request", "requestId": "a", "tool": {"name":"Bash"},
            })
        ),
        Some(PendingChange::Waiting)
    );
    // A duplicate request does not create a new edge.
    assert_eq!(
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.permission.request", "requestId": "a", "tool": {"name":"Bash"},
            })
        ),
        None
    );
    pending.lock().unwrap().permissions.clear();
    assert_eq!(
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.request", "requestId": "b", "questions": [{"question":"Continue?"}],
            })
        ),
        Some(PendingChange::Waiting)
    );
    assert_eq!(
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.cancelled", "requestId": "b",
            })
        ),
        Some(PendingChange::Drained)
    );
}

/// Pause at the post-flush boundary, replace the runtime, then finish the old
/// response. Its delayed completion must not drain the replacement's attention.
#[cfg(unix)]
#[tokio::test]
async fn a_response_from_a_replaced_runtime_cannot_clear_the_new_waiting_interval() {
    #[derive(Default)]
    struct Observer(std::sync::Mutex<Vec<&'static str>>);
    impl crate::claude_edges::AttentionObserver for Observer {
        fn on_waiting(&self, _: &str, _: &str, _: i64) {
            self.0.lock().unwrap().push("waiting");
        }
        fn on_pending_drained(&self, _: &str) {
            self.0.lock().unwrap().push("drained");
        }
    }
    let observer = Arc::new(Observer::default());
    let (tx, mut rx) = tokio::sync::broadcast::channel(64);
    let state = FreshClaudeState::new(Arc::new(tx)).with_attention_observer(observer.clone());
    let old_request =
        json!({"type":"sdk.permission.request", "requestId":"reused", "tool":{"name":"Bash"}});
    tests::insert_fake_claude_session_with_pending(&state, "same-id", None, &[old_request]).await;
    let old = state
        .response_session("same-id", SessionType::Freshclaude)
        .await
        .unwrap();

    tests::insert_fake_claude_session_with_pending(&state, "same-id", None, &[]).await;
    let new = state
        .response_session("same-id", SessionType::Freshclaude)
        .await
        .unwrap();
    let new_request =
        json!({"type":"sdk.permission.request", "requestId":"reused", "tool":{"name":"Read"}});
    state
        .publish_pending_frame("same-id", &new.pending, &new_request, "freshclaude")
        .await;
    assert_eq!(*observer.0.lock().unwrap(), ["waiting"]);

    state
        .complete_pending_response(&old, "reused", PendingResponse::Approval)
        .await;
    state
        .publish_pending_frame(
            "same-id",
            &old.pending,
            &json!({"type":"sdk.permission.cancelled", "requestId":"reused"}),
            "freshclaude",
        )
        .await;
    assert_eq!(
        *observer.0.lock().unwrap(),
        ["waiting"],
        "obsolete work cannot clear current attention"
    );
    assert_eq!(
        new.pending.lock().unwrap().permissions[0].request_id,
        "reused"
    );
    assert_eq!(
        old.pending.lock().unwrap().permissions.len(),
        1,
        "the obsolete pending set is not mutated after replacement"
    );
    let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .collect();
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["event"]["type"] == "freshAgent.permission.cancelled")
            .count(),
        0
    );

    state
        .complete_pending_response(&new, "reused", PendingResponse::Approval)
        .await;
    assert_eq!(*observer.0.lock().unwrap(), ["waiting", "drained"]);
    state.shutdown().await;
}
