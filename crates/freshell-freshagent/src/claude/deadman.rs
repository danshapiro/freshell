//! Per-runtime wiring of the shared quiet deadman. Pending user input pauses it.

use super::*;
use crate::quiet_deadman::{wait_for_quiet_deadline, QuietDeadman};

pub(super) type SharedQuiet = Arc<std::sync::Mutex<QuietDeadman>>;

pub(super) struct QuietWatch {
    pub(super) state: SharedQuiet,
    waiter: Option<tokio::task::AbortHandle>,
}

impl Default for QuietWatch {
    fn default() -> Self {
        Self {
            state: QuietDeadman::new_shared(),
            waiter: None,
        }
    }
}

impl Drop for QuietWatch {
    fn drop(&mut self) {
        self.state.lock().expect("quiet deadman lock").disarm();
        if let Some(waiter) = self.waiter.take() {
            waiter.abort();
        }
    }
}

fn positive_ms(environment: Option<&[(String, String)]>, name: &str) -> Option<u64> {
    let value = match environment {
        Some(environment) => environment
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone()),
        None => std::env::var(name).ok(),
    };
    value
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
}

pub(super) fn quiet_window(environment: Option<&[(String, String)]>) -> Duration {
    Duration::from_millis(
        positive_ms(environment, "FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS").unwrap_or(600_000),
    )
}

pub(super) fn heartbeat_cap_ms(environment: Option<&[(String, String)]>) -> u64 {
    positive_ms(environment, "FRESHELL_FRESHCLAUDE_TOOL_HEARTBEAT_CAP_MS").unwrap_or_else(|| {
        positive_ms(environment, "BASH_MAX_TIMEOUT_MS")
            .unwrap_or(600_000)
            .saturating_add(120_000)
    })
}

impl FreshClaudeState {
    pub(super) async fn note_claude_stdout(
        &self,
        map_key: &str,
        ownership_id: &str,
        line: Option<&Value>,
    ) {
        let capped_tool_heartbeat = line.is_some_and(|line| {
            line["type"] == "sdk.heartbeat"
                && line["kind"] == "tool"
                && line["elapsedMs"].as_f64().is_some_and(|elapsed| {
                    elapsed >= heartbeat_cap_ms(self.sidecar_environment.as_deref()) as f64
                })
        });
        if capped_tool_heartbeat {
            return;
        }
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions
            .get_mut(map_key)
            .filter(|session| session.ownership_id == ownership_id)
        {
            self.refresh_claude_quiet(
                session,
                map_key,
                line.is_some_and(|line| line["type"] == "sdk.result"),
            );
        }
    }

    pub(super) async fn arm_claude_quiet(
        &self,
        map_key: &str,
        ledger: &crate::claude_turns::SharedLedger,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions
            .get_mut(map_key)
            .filter(|session| Arc::ptr_eq(&session.ledger, ledger))
        {
            self.refresh_claude_quiet(session, map_key, false);
        }
    }

    /// The caller holds the sessions map, with no ledger/pending guard held.
    /// Every publisher that also needs quiet and ledger locks takes quiet first.
    pub(super) fn refresh_claude_quiet(
        &self,
        session: &mut ClaudeSession,
        map_key: &str,
        defer_status: bool,
    ) {
        let busy = session.ledger.lock().expect("turn ledger lock").busy();
        let pending = session.pending.lock().expect("pending lock").len() > 0;
        let window = quiet_window(self.sidecar_environment.as_deref());
        let feed = session
            .quiet
            .state
            .lock()
            .expect("quiet deadman lock")
            .feed(busy && !pending, window);
        let stamp = session
            .broadcast_id
            .lock()
            .expect("broadcast id lock")
            .clone();
        if let Some(waiter) = session.quiet.waiter.take() {
            waiter.abort();
            if busy && pending {
                tracing::info!(provider = PROVIDER, session_id = %stamp, phase = "paused",
                    "freshagent.claude.quiet_deadman");
            }
        }
        if feed.resolved {
            tracing::info!(provider = PROVIDER, session_id = %stamp, phase = "resolved",
                "freshagent.claude.quiet_deadman");
        }
        if let Some(armed) = feed.armed {
            if armed.fresh {
                tracing::info!(provider = PROVIDER, session_id = %stamp, phase = "armed",
                    quiet_window_ms = window.as_millis() as u64,
                    tool_heartbeat_cap_ms = heartbeat_cap_ms(self.sidecar_environment.as_deref()),
                    "freshagent.claude.quiet_deadman");
            }
            let watch = self.clone().watch_claude_quiet_deadline(
                map_key.to_string(),
                session.ownership_id.clone(),
                session.quiet.state.clone(),
                session.ledger.clone(),
                session.pending.clone(),
                armed.generation,
            );
            session.quiet.waiter = Some(tokio::spawn(watch).abort_handle());
        }
        // The consumer forwards a result before its resulting status, even
        // when other queued commands leave the session busy.
        if feed.resolved && busy && !defer_status {
            self.publish_claude_status(
                &session.ledger,
                &session.quiet.state,
                &stamp,
                &session.session_type,
                false,
            );
        }
    }

    async fn watch_claude_quiet_deadline(
        self,
        map_key: String,
        ownership_id: String,
        quiet: SharedQuiet,
        ledger: crate::claude_turns::SharedLedger,
        pending: Arc<std::sync::Mutex<ClaudePending>>,
        generation: u64,
    ) {
        if !wait_for_quiet_deadline(&quiet, generation, || {
            let busy = ledger.lock().expect("turn ledger lock").busy();
            let pending = pending.lock().expect("pending lock").len() > 0;
            busy && !pending
        })
        .await
        {
            return;
        }
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions
            .get(&map_key)
            .filter(|session| session.ownership_id == ownership_id)
        else {
            return;
        };
        let quiet = quiet.lock().expect("quiet deadman lock");
        if !quiet.is_stuck_generation(generation) {
            return;
        }
        let mut ledger = ledger.lock().expect("turn ledger lock");
        if !ledger.busy() || session.pending.lock().expect("pending lock").len() > 0 {
            return;
        }
        let stamp = session
            .broadcast_id
            .lock()
            .expect("broadcast id lock")
            .clone();
        self.publish_locked_status(&mut ledger, &stamp, &session.session_type, false, true);
        tracing::warn!(provider = PROVIDER, session_id = %stamp, ownership_id = %ownership_id,
            phase = "fired", generation, "freshagent.claude.quiet_deadman");
        self.edges.quiet_deadman(&crate::claude_edges::EdgeRecord {
            session_key: &map_key,
            stamp: &stamp,
            sidecar_session_id: &session.sidecar_session_id,
            session_type: &session.session_type,
            clock: &session.clock,
        });
    }
}
