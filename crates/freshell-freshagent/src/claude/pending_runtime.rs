//! Pending cards and their attention transitions share one ordering boundary.
//! No sidecar I/O runs here. The sessions-map guard fences the incarnation and
//! the pending guard covers mutation through synchronous frame/edge publication.

use super::*;

pub(super) enum PendingResponse {
    Approval,
    Question,
}

pub(super) fn is_pending_frame(value: &Value) -> bool {
    matches!(
        value["type"].as_str(),
        Some(
            "sdk.permission.request"
                | "sdk.permission.cancelled"
                | "sdk.question.request"
                | "sdk.question.cancelled"
        )
    )
}

impl FreshClaudeState {
    pub(super) async fn complete_pending_response(
        &self,
        response: &ResponseSession,
        request_id: &str,
        kind: PendingResponse,
    ) {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(&response.map_key).filter(|session| {
            session.ownership_id == response.ownership_id
                && Arc::ptr_eq(&session.pending, &response.pending)
        }) else {
            return;
        };
        let mut pending = session.pending.lock().expect("pending lock");
        let before = pending.len();
        match kind {
            PendingResponse::Approval => pending.permissions.retain(|p| p.request_id != request_id),
            PendingResponse::Question => pending.questions.retain(|q| q.request_id != request_id),
        }
        if PendingChange::between(before, pending.len()) == Some(PendingChange::Drained) {
            let stamp = session
                .broadcast_id
                .lock()
                .expect("broadcast id lock")
                .clone();
            self.edges.pending_drained(&stamp);
        }
    }

    pub(super) async fn publish_pending_frame(
        &self,
        map_key: &str,
        expected_pending: &Arc<std::sync::Mutex<ClaudePending>>,
        value: &Value,
        session_type: &str,
    ) {
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions
            .get(map_key)
            .filter(|session| Arc::ptr_eq(&session.pending, expected_pending))
        else {
            return;
        };
        let stamp = session
            .broadcast_id
            .lock()
            .expect("broadcast id lock")
            .clone();
        self.publish_claude_status(&session.ledger, &stamp, session_type, false);
        let mut pending = session.pending.lock().expect("pending lock");
        let change = pending.fold_frame(value);
        if let Some(frame) = sdk_line_to_frame(value, &stamp, session_type) {
            let _ = self.broadcast_tx.send(frame);
        }
        match change {
            Some(PendingChange::Waiting) => {
                self.edges.waiting(&crate::claude_edges::EdgeRecord {
                    session_key: map_key,
                    stamp: &stamp,
                    sidecar_session_id: &session.sidecar_session_id,
                    session_type,
                    clock: &session.clock,
                });
            }
            Some(PendingChange::Drained) => self.edges.pending_drained(&stamp),
            None => {}
        }
    }
}
