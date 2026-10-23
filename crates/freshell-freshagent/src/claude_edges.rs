//! The one place a claude attention edge leaves the server (core-runtime design
//! §3.2, §5.5, §9.2 I-1, §9.3 I3; C18).
//!
//! Every `freshAgent.turn.complete` and `freshAgent.turn.waiting` a freshclaude
//! or kilroy pane receives is minted here, by the server: a result that rings
//! (its verdict, `claude_turns.rs`), a sidecar that ended while a turn was owed,
//! a pending approval or question appearing. The sidecar mints none. Each edge:
//!
//! 1. takes its `at` from the session's [`AttentionClock`], so edges from every
//!    source are strictly ordered per session (G24);
//! 2. is logged at info as `freshagent.turn.complete` / `freshagent.turn.waiting`
//!    with the provider, the ids, the source and `at` (never content, G14);
//! 3. is broadcast as the client frame (its shape is unchanged);
//! 4. is reported to the [`AttentionObserver`], when one is installed (the
//!    client-alerts work's attention ledger, §9.2 I-1);
//! 5. is published as a typed [`ClaudeTurnEvent`] on a low-volume channel of its
//!    own (the agent API's turn correlation, §9.3 I3), which never carries
//!    stream traffic and so cannot lag behind it. A result the user's Stop
//!    silenced rings nothing but is still published, with no `at`.

use std::sync::{Arc, RwLock};

use serde_json::json;
use tokio::sync::broadcast;

use crate::attention::AttentionClock;
use crate::claude_turns::TurnOutcome;
use freshell_protocol::{FreshAgentEvent, ServerMessage};

const PROVIDER: &str = "claude";

/// How many turn events a slow subscriber may fall behind by before it loses
/// the oldest (one per settled turn, waiting edge or session end: low volume).
const TURN_EVENTS_CAPACITY: usize = 256;

/// Hooks for whoever keeps the claude sessions' attention state (the
/// client-alerts work's attention ledger, design §9.2 I-1 and I-2). Every hook
/// has a default that does nothing. Ids are the ids clients address the
/// session by (its envelope stamp).
pub trait AttentionObserver: Send + Sync {
    /// A session was registered (a create, or a resume).
    fn on_registered(&self, _id: &str, _session_type: &str) {}
    /// A `freshAgent.turn.complete` edge left the server.
    fn on_turn_complete(&self, _id: &str, _session_type: &str, _at: i64) {}
    /// A `freshAgent.turn.waiting` edge left the server.
    fn on_waiting(&self, _id: &str, _session_type: &str, _at: i64) {}
    /// The session's pending approvals and questions dropped back to none.
    fn on_pending_drained(&self, _id: &str) {}
    /// The id clients address the session by changed from `old` to `new`.
    fn on_rekeyed(&self, _old: &str, _new: &str) {}
    /// The session was closed by request.
    fn on_forgotten(&self, _id: &str) {}
}

/// A claude turn event for in-process observers (design §9.3 I3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaudeTurnEvent {
    /// A result settled a turn. `at` is its edge's, or `None` when the user's
    /// Stop silenced it.
    Settled {
        /// The sessions-map key (the `session_key` of a send's acceptance).
        session_key: String,
        /// The request ids of the sends the result ended (an absorbed send ends
        /// with the turn that absorbed it; a compact has no request id).
        retired_request_ids: Vec<String>,
        /// The uuids of the commands the result ended.
        retired_command_ids: Vec<String>,
        outcome: TurnOutcome,
        at: Option<i64>,
    },
    /// The session started waiting on its user (an approval or a question).
    Waiting { session_key: String, at: i64 },
    /// The session's sidecar ended unrequested; `reason` is why
    /// (`cli_exited`, `stream_error`, `stream_eof` or `sidecar_exited`).
    Ended { session_key: String, reason: String },
}

/// The two attention edges (AGENTS.md "Agent Status Indicators").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EdgeKind {
    TurnComplete,
    Waiting,
}

impl EdgeKind {
    /// The client event type.
    pub(crate) fn wire_type(self) -> &'static str {
        match self {
            Self::TurnComplete => "freshAgent.turn.complete",
            Self::Waiting => "freshAgent.turn.waiting",
        }
    }
}

/// What minted an edge (the logged `source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EdgeSource {
    /// A turn's result that rings (design §5.3).
    Result,
    /// The sidecar ended unrequested while a turn was owed (§5.7).
    Death,
    /// Pending approvals or questions went from none to some.
    Pending,
}

impl EdgeSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Result => "result",
            Self::Death => "death",
            Self::Pending => "pending",
        }
    }
}

/// The session an edge is minted for.
pub(crate) struct EdgeRecord<'a> {
    /// The sessions-map key (turn events name it).
    pub(crate) session_key: &'a str,
    /// The id the session's frames are stamped with (clients address it so).
    pub(crate) stamp: &'a str,
    /// The id the sidecar knows the session by (the edge event names it).
    pub(crate) sidecar_session_id: &'a str,
    pub(crate) session_type: &'a str,
    /// The session's clock.
    pub(crate) clock: &'a AttentionClock,
}

/// One settled turn, as the hub reports it.
pub(crate) struct SettledReport {
    pub(crate) rings: bool,
    pub(crate) outcome: TurnOutcome,
    pub(crate) retired_request_ids: Vec<String>,
    pub(crate) retired_command_ids: Vec<String>,
}

/// The choke point (design §5.5). Cheap to clone: every clone shares the bus,
/// the observer slot and the turn-event channel.
#[derive(Clone)]
pub(crate) struct ClaudeEdgeHub {
    broadcast_tx: Arc<broadcast::Sender<String>>,
    observer: Arc<RwLock<Option<Arc<dyn AttentionObserver>>>>,
    turn_events: broadcast::Sender<ClaudeTurnEvent>,
}

impl ClaudeEdgeHub {
    pub(crate) fn new(broadcast_tx: Arc<broadcast::Sender<String>>) -> Self {
        Self {
            broadcast_tx,
            observer: Arc::new(RwLock::new(None)),
            turn_events: broadcast::channel(TURN_EVENTS_CAPACITY).0,
        }
    }

    /// Install the observer every clone reports to.
    pub(crate) fn set_observer(&self, observer: Arc<dyn AttentionObserver>) {
        *self.observer.write().expect("attention observer lock") = Some(observer);
    }

    /// A receiver of every turn event published from now on.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ClaudeTurnEvent> {
        self.turn_events.subscribe()
    }

    fn observe(&self, notify: impl FnOnce(&dyn AttentionObserver)) {
        let observer = self
            .observer
            .read()
            .expect("attention observer lock")
            .clone();
        if let Some(observer) = observer {
            notify(observer.as_ref());
        }
    }

    fn publish(&self, event: ClaudeTurnEvent) {
        // No subscriber is not an error: the events are for whoever listens.
        let _ = self.turn_events.send(event);
    }

    /// Mint, log, broadcast and report one edge. Every claude edge leaves
    /// through here.
    fn emit(&self, record: &EdgeRecord<'_>, kind: EdgeKind, source: EdgeSource) -> i64 {
        let at = record.clock.mint();
        let source_name = source.as_str();
        match kind {
            EdgeKind::TurnComplete => tracing::info!(
                provider = PROVIDER, session_id = %record.stamp,
                session_type = %record.session_type, source = source_name, at,
                "freshagent.turn.complete"
            ),
            EdgeKind::Waiting => tracing::info!(
                provider = PROVIDER, session_id = %record.stamp,
                session_type = %record.session_type, source = source_name, at,
                "freshagent.turn.waiting"
            ),
        }
        let frame = ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": kind.wire_type(),
                "sessionId": record.sidecar_session_id,
                "at": at,
            }),
            provider: PROVIDER.to_string(),
            session_id: record.stamp.to_string(),
            session_type: record.session_type.to_string(),
        });
        if let Ok(frame) = serde_json::to_string(&frame) {
            let _ = self.broadcast_tx.send(frame);
        }
        self.observe(|observer| match kind {
            EdgeKind::TurnComplete => {
                observer.on_turn_complete(record.stamp, record.session_type, at)
            }
            EdgeKind::Waiting => observer.on_waiting(record.stamp, record.session_type, at),
        });
        at
    }

    /// A result settled a turn: ring it unless the user's Stop silenced it, and
    /// publish the settlement either way. Returns the edge's `at`, if it rang.
    pub(crate) fn settle(&self, record: &EdgeRecord<'_>, settled: SettledReport) -> Option<i64> {
        let at = settled
            .rings
            .then(|| self.emit(record, EdgeKind::TurnComplete, EdgeSource::Result));
        self.publish(ClaudeTurnEvent::Settled {
            session_key: record.session_key.to_string(),
            retired_request_ids: settled.retired_request_ids,
            retired_command_ids: settled.retired_command_ids,
            outcome: settled.outcome,
            at,
        });
        at
    }

    /// Pending approvals or questions went from none to some.
    pub(crate) fn waiting(&self, record: &EdgeRecord<'_>) -> i64 {
        let at = self.emit(record, EdgeKind::Waiting, EdgeSource::Pending);
        self.publish(ClaudeTurnEvent::Waiting {
            session_key: record.session_key.to_string(),
            at,
        });
        at
    }

    /// The sidecar ended unrequested: ring when a turn was owed, and publish the
    /// end either way.
    pub(crate) fn ended(&self, record: &EdgeRecord<'_>, owed: bool, reason: &str) -> Option<i64> {
        let at = owed.then(|| self.emit(record, EdgeKind::TurnComplete, EdgeSource::Death));
        self.publish(ClaudeTurnEvent::Ended {
            session_key: record.session_key.to_string(),
            reason: reason.to_string(),
        });
        at
    }

    /// The session's pending approvals and questions dropped back to none.
    pub(crate) fn pending_drained(&self, stamp: &str) {
        self.observe(|observer| observer.on_pending_drained(stamp));
    }

    /// A session was registered under `id`.
    pub(crate) fn registered(&self, id: &str, session_type: &str) {
        self.observe(|observer| observer.on_registered(id, session_type));
    }

    /// The id clients address a session by changed.
    pub(crate) fn rekeyed(&self, old: &str, new: &str) {
        if old != new {
            self.observe(|observer| observer.on_rekeyed(old, new));
        }
    }

    /// A session was closed by request.
    pub(crate) fn forgotten(&self, id: &str) {
        self.observe(|observer| observer.on_forgotten(id));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;
    use crate::claude_sidecar_io::test_capture::{capture, with_message};

    /// Every hook call, in order.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    impl AttentionObserver for Recorder {
        fn on_registered(&self, id: &str, session_type: &str) {
            self.0
                .lock()
                .unwrap()
                .push(format!("registered {id} {session_type}"));
        }
        fn on_turn_complete(&self, id: &str, session_type: &str, at: i64) {
            self.0
                .lock()
                .unwrap()
                .push(format!("complete {id} {session_type} {at}"));
        }
        fn on_waiting(&self, id: &str, session_type: &str, at: i64) {
            self.0
                .lock()
                .unwrap()
                .push(format!("waiting {id} {session_type} {at}"));
        }
        fn on_pending_drained(&self, id: &str) {
            self.0.lock().unwrap().push(format!("drained {id}"));
        }
        fn on_rekeyed(&self, old: &str, new: &str) {
            self.0.lock().unwrap().push(format!("rekeyed {old} {new}"));
        }
        fn on_forgotten(&self, id: &str) {
            self.0.lock().unwrap().push(format!("forgotten {id}"));
        }
    }

    fn hub() -> (ClaudeEdgeHub, broadcast::Receiver<String>) {
        let (tx, rx) = broadcast::channel(64);
        (ClaudeEdgeHub::new(Arc::new(tx)), rx)
    }

    fn record<'a>(clock: &'a AttentionClock) -> EdgeRecord<'a> {
        EdgeRecord {
            session_key: "key-1",
            stamp: "envelope-1",
            sidecar_session_id: "sidecar-1",
            session_type: "kilroy",
            clock,
        }
    }

    fn settled(rings: bool, outcome: TurnOutcome) -> SettledReport {
        SettledReport {
            rings,
            outcome,
            retired_request_ids: vec!["req-1".into()],
            retired_command_ids: vec!["uuid-1".into()],
        }
    }

    fn frames(rx: &mut broadcast::Receiver<String>) -> Vec<Value> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| serde_json::from_str(&frame).unwrap())
            .collect()
    }

    /// Design §5.5 steps 1-4: each edge is minted on the session's clock,
    /// logged at info with its source (ids only), broadcast as the client frame
    /// and reported to the observer.
    #[test]
    fn every_edge_is_minted_logged_broadcast_and_observed() {
        let (events, _guard) = capture();
        let (hub, mut rx) = hub();
        let recorder = Arc::new(Recorder::default());
        hub.set_observer(recorder.clone());
        let clock = AttentionClock::default();
        let record = record(&clock);

        let complete = hub.settle(&record, settled(true, TurnOutcome::Completed));
        let waiting = hub.waiting(&record);
        let death = hub.ended(&record, true, "cli_exited");
        let (complete, death) = (complete.unwrap(), death.unwrap());
        assert!(
            complete < waiting && waiting < death,
            "one clock: {complete} {waiting} {death}"
        );

        let frames = frames(&mut rx);
        for frame in &frames {
            assert_eq!(frame["type"], "freshAgent.event");
            assert_eq!(frame["provider"], "claude");
            assert_eq!(frame["sessionId"], "envelope-1");
            assert_eq!(frame["sessionType"], "kilroy");
        }
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame["event"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!({ "type": "freshAgent.turn.complete", "sessionId": "sidecar-1", "at": complete }),
                json!({ "type": "freshAgent.turn.waiting", "sessionId": "sidecar-1", "at": waiting }),
                json!({ "type": "freshAgent.turn.complete", "sessionId": "sidecar-1", "at": death }),
            ]
        );

        let logged = |message| {
            with_message(&events, message)
                .iter()
                .map(|event| {
                    assert_eq!(event.level, tracing::Level::INFO);
                    assert_eq!(event.field("provider"), Some("claude"));
                    assert_eq!(event.field("session_id"), Some("envelope-1"));
                    assert_eq!(event.field("session_type"), Some("kilroy"));
                    (
                        event.field("source").unwrap_or_default().to_string(),
                        event.field("at").unwrap_or_default().to_string(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            logged("freshagent.turn.complete"),
            vec![
                ("result".to_string(), complete.to_string()),
                ("death".to_string(), death.to_string()),
            ]
        );
        assert_eq!(
            logged("freshagent.turn.waiting"),
            vec![("pending".to_string(), waiting.to_string())]
        );
        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![
                format!("complete envelope-1 kilroy {complete}"),
                format!("waiting envelope-1 kilroy {waiting}"),
                format!("complete envelope-1 kilroy {death}"),
            ]
        );
    }

    /// G24: a death right after a result, in the same millisecond, still gets
    /// a strictly larger `at` (the client drops an edge whose `at` is not above
    /// the last one it saw for the session).
    #[test]
    fn a_death_after_a_result_in_the_same_millisecond_gets_a_larger_at() {
        let (hub, _rx) = hub();
        let clock = AttentionClock::default();
        // Hold the wall clock: the floor is ahead of now, as for two edges in
        // one millisecond.
        let ahead = crate::rollback_record::now_ms() + 60_000;
        clock.observe(ahead);
        let record = record(&clock);
        let result = hub
            .settle(&record, settled(true, TurnOutcome::Completed))
            .unwrap();
        let death = hub.ended(&record, true, "sidecar_exited").unwrap();
        assert_eq!(result, ahead + 1);
        assert_eq!(death, ahead + 2);
    }

    /// Design §9.3 I3: every settled turn is published with what it retired,
    /// a silenced one with no `at`; waiting edges and session ends too.
    #[tokio::test]
    async fn turn_events_are_published_for_every_settlement_waiting_edge_and_end() {
        let (hub, mut rx) = hub();
        let mut events = hub.subscribe();
        let clock = AttentionClock::default();
        let record = record(&clock);

        let rang = hub.settle(&record, settled(true, TurnOutcome::Failed));
        let silent = hub.settle(&record, settled(false, TurnOutcome::Interrupted));
        assert_eq!(silent, None);
        let waiting = hub.waiting(&record);
        assert_eq!(
            hub.ended(&record, false, "stream_eof"),
            None,
            "an idle death is silent"
        );

        let received: Vec<ClaudeTurnEvent> =
            std::iter::from_fn(|| events.try_recv().ok()).collect();
        assert_eq!(
            received,
            vec![
                ClaudeTurnEvent::Settled {
                    session_key: "key-1".into(),
                    retired_request_ids: vec!["req-1".into()],
                    retired_command_ids: vec!["uuid-1".into()],
                    outcome: TurnOutcome::Failed,
                    at: rang,
                },
                ClaudeTurnEvent::Settled {
                    session_key: "key-1".into(),
                    retired_request_ids: vec!["req-1".into()],
                    retired_command_ids: vec!["uuid-1".into()],
                    outcome: TurnOutcome::Interrupted,
                    at: None,
                },
                ClaudeTurnEvent::Waiting {
                    session_key: "key-1".into(),
                    at: waiting,
                },
                ClaudeTurnEvent::Ended {
                    session_key: "key-1".into(),
                    reason: "stream_eof".into(),
                },
            ]
        );
        assert_eq!(
            frames(&mut rx)
                .iter()
                .filter(|frame| frame["event"]["type"] == "freshAgent.turn.complete")
                .count(),
            1,
            "only the turn that rang put an edge on the wire"
        );
    }

    #[test]
    fn the_identity_hooks_reach_the_observer_and_nothing_breaks_without_one() {
        let (hub, _rx) = hub();
        hub.registered("a", "freshclaude");
        hub.pending_drained("a");
        let recorder = Arc::new(Recorder::default());
        hub.clone().set_observer(recorder.clone());
        hub.registered("a", "freshclaude");
        hub.rekeyed("a", "a");
        hub.rekeyed("a", "b");
        hub.pending_drained("b");
        hub.forgotten("b");
        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![
                "registered a freshclaude",
                "rekeyed a b",
                "drained b",
                "forgotten b",
            ]
        );
    }
}
