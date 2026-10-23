//! The side of the turn ledger that talks to the world (design §5.2, C17): the
//! stdout consumer folds each sidecar line into the session's
//! [`ClaudeTurnLedger`](crate::claude_turns::ClaudeTurnLedger) and logs what it
//! settled, and the session's effective status is published from the ledger
//! whenever it changes. The ledger itself is pure (`claude_turns.rs`).

use serde_json::{json, Value};

use super::{FreshClaudeState, PROVIDER};
use crate::claude_turns::{
    EffectiveStatus, Folded, ResultVerdict, SharedLedger, StopReissue, TurnFact,
};
use freshell_protocol::{FreshAgentEvent, ServerMessage};

const TARGET: &str = "freshell_freshagent::claude";

/// The banner code of a failed turn (design §5.3, §6).
pub(super) const TURN_FAILED_CODE: &str = "CLAUDE_TURN_FAILED";

/// What folding one sidecar line asks the stdout consumer to do next.
pub(super) enum LedgerStep {
    /// Nothing beyond forwarding the line.
    Nothing,
    /// A result settled a turn (design §5.3): forward it with `sessionBusy`,
    /// then show its banner and ring its edge as its verdict says.
    Settled(SettledTurn),
    /// A latched Stop missed a command the CLI was still starting: send the
    /// interrupt again (§5.4).
    Reissue(StopReissue),
    /// The CLI refused the latched Stop's interrupt; the turn keeps running.
    StopRefused { stop_id: String },
}

/// One settled turn, as the consumer reports it.
pub(super) struct SettledTurn {
    /// The session is still busy after it (the result frame's `sessionBusy`).
    pub(super) busy: bool,
    pub(super) verdict: ResultVerdict,
    /// The request ids of the commands it retired (compacts have none).
    pub(super) request_ids: Vec<String>,
    /// The uuids of the commands it retired.
    pub(super) command_ids: Vec<String>,
}

/// The `freshAgent.status` event for the session's envelope id.
pub(crate) fn status_event(session_id: &str, status: EffectiveStatus) -> Value {
    json!({
        "type": "freshAgent.status",
        "sessionId": session_id,
        "status": status.as_str(),
    })
}

impl FreshClaudeState {
    /// The id the live session `map_key` stamps its frames with (the map key
    /// until an attach rebinds it to the durable id).
    pub(super) async fn envelope_stamp(&self, map_key: &str) -> String {
        self.sessions
            .lock()
            .await
            .get(map_key)
            .map(|session| {
                session
                    .broadcast_id
                    .lock()
                    .expect("broadcast id lock")
                    .clone()
            })
            .unwrap_or_else(|| map_key.to_string())
    }

    /// Take back a send armed in the ledger whose write never went out:
    /// exactly that command leaves (whatever else is owed stays), and the
    /// status follows.
    pub(super) fn take_back_unwritten_send(
        &self,
        ledger: &SharedLedger,
        session_id: &str,
        session_type: &str,
        uuid: &str,
    ) {
        ledger.lock().expect("turn ledger lock").undo_arm(uuid);
        self.publish_claude_status(ledger, session_id, session_type, false);
    }

    /// Say the live session `any_id` names its effective status, changed or
    /// not, right after its `freshAgent.created`: a new pane learns it is ready
    /// (or, for a create that found the session live, busy) without waiting for
    /// a turn. Nothing is said for an id with no live session.
    pub(super) async fn announce_claude_status(&self, any_id: &str, session_type: &str) {
        let Some(key) = self.resolve_session_key(any_id).await else {
            return;
        };
        let live = self.sessions.lock().await.get(&key).map(|session| {
            let session_id = session
                .broadcast_id
                .lock()
                .expect("broadcast id lock")
                .clone();
            (session.ledger.clone(), session_id)
        });
        let Some((ledger, session_id)) = live else {
            return;
        };
        let mut ledger = ledger.lock().expect("turn ledger lock");
        let status = ledger
            .take_status_change(false)
            .unwrap_or_else(|| ledger.published_status());
        tracing::debug!(target: TARGET, provider = PROVIDER, session_id = %session_id,
            session_type, status = status.as_str(), announced = true, "freshagent.claude.status");
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: status_event(&session_id, status),
            provider: PROVIDER.to_string(),
            session_id,
            session_type: session_type.to_string(),
        }));
    }

    /// Fold one sidecar line into the session's ledger and say what it asks for
    /// next ([`LedgerStep`]). Settlements are logged at debug with their
    /// verdict, the old-CLI head fallback at warn, an unknown command at debug.
    pub(super) fn fold_into_ledger(
        &self,
        ledger: &SharedLedger,
        line: &Value,
        broadcast_id: &std::sync::Mutex<String>,
        session_type: &str,
    ) -> LedgerStep {
        let Some(fact) = TurnFact::from_line(line) else {
            return LedgerStep::Nothing;
        };
        let (folded, busy) = {
            let mut ledger = ledger.lock().expect("turn ledger lock");
            let folded = ledger.fold(&fact);
            (folded, ledger.busy())
        };
        let session_id = broadcast_id.lock().expect("broadcast id lock").clone();
        match folded {
            Folded::Applied => LedgerStep::Nothing,
            Folded::UnknownCommand => {
                let uuid = line.get("uuid").and_then(serde_json::Value::as_str);
                let state = line.get("state").and_then(serde_json::Value::as_str);
                tracing::debug!(target: TARGET, provider = PROVIDER,
                    session_id = %session_id, session_type, uuid, state,
                    "freshagent.claude.ledger_unknown_command");
                LedgerStep::Nothing
            }
            Folded::Reissue(reissue) => LedgerStep::Reissue(reissue),
            Folded::StopRefused { stop_id } => LedgerStep::StopRefused { stop_id },
            Folded::Settled(settlement) => {
                let command_ids: Vec<String> = settlement
                    .retired
                    .iter()
                    .map(|command| command.uuid.clone())
                    .collect();
                let request_ids: Vec<String> = settlement
                    .retired
                    .iter()
                    .filter_map(|command| command.request_id.clone())
                    .collect();
                if settlement.head_retired {
                    tracing::warn!(target: TARGET, provider = PROVIDER,
                        session_id = %session_id, session_type, retired = ?command_ids,
                        "ledger.fallback_head_retire: the CLI reports no command \
                         lifecycle and no command started, so the result settles the \
                         oldest one sent");
                }
                tracing::debug!(target: TARGET, provider = PROVIDER,
                    session_id = %session_id, session_type, retired = ?command_ids,
                    request_ids = ?request_ids, session_busy = busy,
                    verdict = settlement.verdict.as_str(),
                    stop_id = settlement.stop_id.as_deref(),
                    "freshagent.claude.turn_settled");
                LedgerStep::Settled(SettledTurn {
                    busy,
                    verdict: settlement.verdict,
                    request_ids,
                    command_ids,
                })
            }
        }
    }

    /// A result settled a turn (design §5.3): after its `freshAgent.result`, a
    /// failed turn shows why (the nested `freshAgent.error{CLAUDE_TURN_FAILED}`
    /// banner, never for an API error, which the transcript shows), and the
    /// turn rings through the edge hub unless the user's Stop silenced it.
    pub(super) fn ring_settled_turn(
        &self,
        record: &crate::claude_edges::EdgeRecord<'_>,
        settled: SettledTurn,
    ) {
        if let Some(message) = settled.verdict.banner() {
            self.emit_fresh_agent_error(
                record.stamp,
                record.session_type,
                TURN_FAILED_CODE,
                message,
            );
        }
        self.edges.settle(
            record,
            crate::claude_edges::SettledReport {
                rings: settled.verdict.rings(),
                outcome: settled.verdict.outcome(),
                retired_request_ids: settled.request_ids,
                retired_command_ids: settled.command_ids,
            },
        );
    }

    /// Publish the session's effective status when it changed (design §5.2
    /// `publish_status`). The broadcast is sent under the ledger lock, so two
    /// publishers (the consumer and a handler's arm) never reorder their
    /// statuses on the wire. `after_result`: a result was just forwarded, so a
    /// status other than `idle` is said again even when unchanged (a client
    /// that predates `sessionBusy` forced its pane idle at the result).
    pub(super) fn publish_claude_status(
        &self,
        ledger: &SharedLedger,
        session_id: &str,
        session_type: &str,
        after_result: bool,
    ) {
        let mut ledger = ledger.lock().expect("turn ledger lock");
        let (status, changed) = match ledger.take_status_change(false) {
            Some(status) => (status, true),
            None if after_result && ledger.published_status() != EffectiveStatus::Idle => {
                (ledger.published_status(), false)
            }
            None => return,
        };
        tracing::debug!(target: TARGET, provider = PROVIDER, session_id, session_type,
            status = status.as_str(), changed, "freshagent.claude.status");
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: status_event(session_id, status),
            provider: PROVIDER.to_string(),
            session_id: session_id.to_string(),
            session_type: session_type.to_string(),
        }));
    }
}
