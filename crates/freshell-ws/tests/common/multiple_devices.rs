//! Shared protocol helpers for Freshagent multi-device attach tests.

use serde_json::{json, Value};

pub const FRESH_AGENT_RECONCILIATION_CAPABILITY: &str = "freshAgentReconciliationV1";

pub fn attach_request(
    provider: &str,
    session_type: &str,
    session_id: &str,
    view_id: &str,
    request_id: &str,
) -> Value {
    json!({
        "type": "freshAgent.attach",
        "provider": provider,
        "sessionType": session_type,
        "sessionId": session_id,
        "sessionRef": { "provider": provider, "sessionId": session_id },
        "viewId": view_id,
        "requestId": request_id,
    })
}

/// Legacy event-shaped attach from a newer client that has a view id but has
/// not opted in to correlated attach outcomes.
pub fn legacy_attach_request(
    provider: &str,
    session_type: &str,
    session_id: &str,
    view_id: &str,
) -> Value {
    json!({
        "type": "freshAgent.attach",
        "provider": provider,
        "sessionType": session_type,
        "sessionId": session_id,
        "sessionRef": { "provider": provider, "sessionId": session_id },
        "viewId": view_id,
    })
}
