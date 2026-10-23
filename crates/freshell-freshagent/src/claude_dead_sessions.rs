//! What a claude session leaves behind when its sidecar ends unrequested
//! (core-runtime design §3.3, §5.7, §6; C09, G05).
//!
//! The end-of-output path evicts the dead session from the live map, but the
//! pane still holds it. So the server keeps a [`DeadClaudeSession`]: the session
//! reports `freshAgent.status{exited}` ([`exited_status_event`]), its snapshot
//! overlay says `exited` from live state (not a stale `idle` or `compacting`), and
//! a send to it is refused visibly instead of vanishing. Resuming the session
//! (attach or a create that resumes it) or closing it forgets the record.
//!
//! Until the durable id is minted at create (C23) a session answers to several
//! ids — its sessions-map key (the pane's id from create or attach), its envelope
//! stamp and its durable claude UUIDs — so a record answers to all of them.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::claude::PROVIDER;
use crate::identity_sink::FreshAgentSettings;

/// How many dead sessions are remembered (codex bounds its dead threads the same
/// way). Past it the oldest death is forgotten.
pub(crate) const DEAD_SESSIONS_CAP: usize = 256;

/// One session whose sidecar ended unrequested.
#[derive(Debug, Clone)]
pub(crate) struct DeadClaudeSession {
    /// Every id the session answered to (never empty).
    pub(crate) ids: Vec<String>,
    /// The settings the session last ran under.
    pub(crate) settings: FreshAgentSettings,
    /// The command catalog the session last published.
    pub(crate) commands: Option<Vec<Value>>,
    /// Why it ended: the `sdk.stream.ended` reason, or `sidecar_exited` for a
    /// sidecar that died without reporting one.
    pub(crate) reason: String,
    /// When it ended (epoch ms).
    pub(crate) at_ms: i64,
}

impl DeadClaudeSession {
    fn answers_to(&self, id: &str) -> bool {
        self.ids.iter().any(|known| known == id)
    }
}

/// The remembered dead sessions, oldest death first.
#[derive(Debug, Default)]
pub(crate) struct DeadClaudeSessions {
    entries: VecDeque<DeadClaudeSession>,
}

impl DeadClaudeSessions {
    /// Remember a death. An earlier record sharing any id is replaced (the session
    /// died again). Returns the record forgotten to stay within
    /// [`DEAD_SESSIONS_CAP`], if any.
    pub(crate) fn record(&mut self, dead: DeadClaudeSession) -> Option<DeadClaudeSession> {
        self.entries
            .retain(|entry| !dead.ids.iter().any(|id| entry.answers_to(id)));
        self.entries.push_back(dead);
        if self.entries.len() > DEAD_SESSIONS_CAP {
            self.entries.pop_front()
        } else {
            None
        }
    }

    /// The record of the dead session answering to `id`.
    pub(crate) fn find(&self, id: &str) -> Option<&DeadClaudeSession> {
        self.entries.iter().rev().find(|entry| entry.answers_to(id))
    }

    /// Forget every record answering to any of `ids` (the session was resumed or
    /// closed). Returns how many were forgotten.
    pub(crate) fn forget<S: AsRef<str>>(&mut self, ids: &[S]) -> usize {
        let before = self.entries.len();
        self.entries
            .retain(|entry| !ids.iter().any(|id| entry.answers_to(id.as_ref())));
        before - self.entries.len()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

/// One death as the end-of-output path knows it, for [`SharedDeadSessions::record`].
pub(crate) struct Death<'a> {
    /// The session's key in the sessions map.
    pub(crate) map_key: &'a str,
    /// The id its events were stamped with.
    pub(crate) stamp: &'a str,
    pub(crate) session_type: &'a str,
    /// The durable ids the session's aliases named.
    pub(crate) durables: &'a [String],
    /// The durable id the session itself held.
    pub(crate) cli_session_id: Option<&'a str>,
    pub(crate) settings: &'a FreshAgentSettings,
    pub(crate) commands: Option<&'a Vec<Value>>,
    /// The `sdk.stream.ended` reason, or `sidecar_exited`.
    pub(crate) reason: &'a str,
}

/// The claude lane's dead-session records, shared by every clone of its state
/// (the end-of-output path records from its consumer task).
#[derive(Clone, Default)]
pub(crate) struct SharedDeadSessions(Arc<Mutex<DeadClaudeSessions>>);

impl SharedDeadSessions {
    /// The record of the session answering to `id` whose sidecar ended
    /// unrequested and that has not been resumed or closed since.
    pub(crate) fn find(&self, id: &str) -> Option<DeadClaudeSession> {
        self.0.lock().expect("dead sessions lock").find(id).cloned()
    }

    /// Record a session the end-of-output path just evicted: it answers to its
    /// map key, its envelope stamp and every durable id it held.
    pub(crate) fn record(&self, death: Death<'_>) {
        let mut ids = vec![death.map_key.to_string()];
        for id in std::iter::once(death.stamp)
            .chain(death.durables.iter().map(String::as_str))
            .chain(death.cli_session_id)
        {
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
        let dead = DeadClaudeSession {
            ids: ids.clone(),
            settings: death.settings.clone(),
            commands: death.commands.cloned(),
            reason: death.reason.to_string(),
            at_ms: crate::rollback_record::now_ms(),
        };
        let (dropped, remembered) = {
            let mut store = self.0.lock().expect("dead sessions lock");
            let dropped = store.record(dead);
            (dropped, store.len())
        };
        tracing::info!(target: "freshell_freshagent::claude",
            provider = PROVIDER, session_id = %death.stamp, session_type = %death.session_type,
            ids = ?ids, reason = death.reason, remembered,
            "freshagent.claude.dead_session_recorded");
        if let Some(dropped) = dropped {
            tracing::info!(target: "freshell_freshagent::claude",
                provider = PROVIDER, ids = ?dropped.ids, died_at_ms = dropped.at_ms,
                cap = DEAD_SESSIONS_CAP,
                "freshagent.claude.dead_session_dropped");
        }
    }

    /// Forget the records answering to any of `ids`: the session is live again
    /// (`resumed`) or the pane closed it (`killed`).
    pub(crate) fn forget<S: AsRef<str>>(&self, ids: &[S], reason: &'static str) {
        let forgotten = self.0.lock().expect("dead sessions lock").forget(ids);
        if forgotten > 0 {
            let ids: Vec<&str> = ids.iter().map(AsRef::as_ref).collect();
            tracing::info!(target: "freshell_freshagent::claude",
                provider = PROVIDER, ids = ?ids, reason, forgotten,
                "freshagent.claude.dead_session_forgotten");
        }
    }
}

/// The `freshAgent.status{exited}` event for the session's envelope id: the
/// session's process is gone, so the pane is not busy and offers Resume.
pub(crate) fn exited_status_event(session_id: &str) -> Value {
    json!({
        "type": "freshAgent.status",
        "sessionId": session_id,
        "status": "exited",
    })
}

/// The request error a send to a dead session gets (the client shows it as the
/// reason the message was not sent).
pub(crate) const SEND_TO_DEAD_SESSION_MESSAGE: &str =
    "The Claude agent process for this session exited. Resume the session to continue.";

#[cfg(test)]
mod tests {
    use super::*;

    fn dead(ids: &[&str]) -> DeadClaudeSession {
        DeadClaudeSession {
            ids: ids.iter().map(|id| id.to_string()).collect(),
            settings: FreshAgentSettings::default(),
            commands: None,
            reason: "cli_exited".into(),
            at_ms: 1,
        }
    }

    #[test]
    fn a_record_answers_to_every_id_the_session_had() {
        let mut store = DeadClaudeSessions::default();
        store.record(dead(&["placeholder", "durable"]));
        assert_eq!(
            store.find("placeholder").map(|d| d.ids.clone()),
            Some(vec!["placeholder".to_string(), "durable".to_string()])
        );
        assert!(store.find("durable").is_some());
        assert!(store.find("someone-else").is_none());
    }

    #[test]
    fn a_second_death_replaces_the_first_record() {
        let mut store = DeadClaudeSessions::default();
        store.record(dead(&["placeholder", "durable"]));
        let mut again = dead(&["placeholder-2", "durable"]);
        again.at_ms = 2;
        store.record(again);
        assert_eq!(store.len(), 1, "one record per session");
        assert_eq!(store.find("durable").map(|d| d.at_ms), Some(2));
        assert!(
            store.find("placeholder").is_none(),
            "the replaced record's other ids go with it"
        );
    }

    #[test]
    fn forgetting_any_id_forgets_the_whole_record() {
        let mut store = DeadClaudeSessions::default();
        store.record(dead(&["placeholder", "durable"]));
        store.record(dead(&["other"]));
        assert_eq!(store.forget(&["durable"]), 1);
        assert!(store.find("placeholder").is_none());
        assert!(store.find("other").is_some());
        assert_eq!(store.forget(&["nobody"]), 0);
    }

    #[test]
    fn past_the_cap_the_oldest_death_is_forgotten() {
        let mut store = DeadClaudeSessions::default();
        for n in 0..DEAD_SESSIONS_CAP {
            assert!(store.record(dead(&[&format!("s{n}")])).is_none());
        }
        let dropped = store.record(dead(&["newest"]));
        assert_eq!(dropped.map(|d| d.ids), Some(vec!["s0".to_string()]));
        assert_eq!(store.len(), DEAD_SESSIONS_CAP);
        assert!(store.find("s0").is_none());
        assert!(store.find("s1").is_some());
        assert!(store.find("newest").is_some());
    }

    #[test]
    fn the_exited_status_event_names_the_session() {
        assert_eq!(
            exited_status_event("pane-id"),
            json!({ "type": "freshAgent.status", "sessionId": "pane-id", "status": "exited" })
        );
    }
}
