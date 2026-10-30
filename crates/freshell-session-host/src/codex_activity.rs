use std::collections::VecDeque;

use freshell_activity::codex::{CodexActivityBatch, CodexActivityEvent};
use freshell_codex::remote_proxy::RemoteProxyEvent;

const MAX_RETAINED_EVENTS: usize = 256;

#[derive(Default)]
pub(crate) struct CodexActivityJournal {
    events: VecDeque<CodexActivityEvent>,
    head_seq: u64,
}

impl CodexActivityJournal {
    pub(crate) fn note_remote_event(&mut self, event: &RemoteProxyEvent, at: i64) {
        let (turn, completed) = match event {
            RemoteProxyEvent::TurnStarted(turn) => (turn, false),
            RemoteProxyEvent::TurnCompleted(turn) => (turn, true),
            _ => return,
        };
        self.head_seq = self.head_seq.saturating_add(1);
        // Native turns must keep distinct clock keys when several are read
        // together, including events received in the same clock millisecond.
        let at = self
            .events
            .back()
            .map_or(at, |last| at.max(last.at.saturating_add(1)));
        self.events.push_back(CodexActivityEvent {
            seq: self.head_seq,
            at,
            thread_id: turn.thread_id.clone(),
            turn_id: turn.turn_id.clone(),
            status: completed
                .then(|| freshell_codex::turn_status(&turn.params))
                .flatten(),
            completed,
        });
        while self.events.len() > MAX_RETAINED_EVENTS {
            self.events.pop_front();
        }
    }

    pub(crate) fn read(&self) -> CodexActivityBatch {
        CodexActivityBatch {
            retained_from_seq: self
                .events
                .front()
                .map_or(self.head_seq.saturating_add(1), |event| event.seq),
            head_seq: self.head_seq,
            events: self.events.iter().cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::remote_proxy::TurnEventParams;

    fn turn(completed: bool) -> RemoteProxyEvent {
        let event = TurnEventParams {
            thread_id: "thread-owned".into(),
            turn_id: Some("turn-owned".into()),
            params: serde_json::from_value(serde_json::json!({
                "turn": {"status":"completed","items":[{"text":"private-provider-body"}]}
            }))
            .unwrap(),
        };
        if completed {
            RemoteProxyEvent::TurnCompleted(event)
        } else {
            RemoteProxyEvent::TurnStarted(event)
        }
    }

    #[test]
    fn native_codex_turns_reach_output_metadata_without_provider_bodies() {
        let mut journal = CodexActivityJournal::default();
        journal.note_remote_event(&turn(false), 100);
        journal.note_remote_event(&turn(true), 100);
        let batch = journal.read();
        batch.validate().unwrap();
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].thread_id, "thread-owned");
        assert!(!batch.events[0].completed);
        assert!(batch.events[1].completed);
        assert_eq!(batch.events[1].status.as_deref(), Some("completed"));
        assert!(batch.events[1].at > batch.events[0].at);
        assert!(!serde_json::to_string(&batch)
            .unwrap()
            .contains("private-provider-body"));
        assert_eq!(
            journal.read(),
            batch,
            "reads must retain observations for reconnecting consumers"
        );
    }

    #[test]
    fn retained_native_codex_activity_stays_bounded_and_reports_its_exact_lost_prefix() {
        let mut journal = CodexActivityJournal::default();
        for _ in 0..150 {
            journal.note_remote_event(&turn(false), 100);
            journal.note_remote_event(&turn(true), 100);
        }
        let batch = journal.read();
        batch.validate().unwrap();
        assert_eq!(batch.events.len(), 256);
        assert_eq!(batch.retained_from_seq, 45);
        assert_eq!(batch.head_seq, 300);
    }

    #[test]
    fn native_codex_activity_retains_failed_and_interrupted_outcomes() {
        let mut journal = CodexActivityJournal::default();
        for status in ["failed", "interrupted"] {
            let mut event = turn(true);
            let RemoteProxyEvent::TurnCompleted(turn) = &mut event else {
                unreachable!()
            };
            turn.params["turn"]["status"] = status.into();
            journal.note_remote_event(&event, 100);
        }
        let batch = journal.read();
        assert_eq!(
            batch
                .events
                .iter()
                .map(|event| event.status.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("failed"), Some("interrupted")]
        );
    }
}
