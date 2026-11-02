//! Connection-local Fresh Agent delivery interest.
//!
//! This tracks which browser pane on this websocket wants conversation frames.
//! It is deliberately not a process owner, lease, or reference count: removing
//! the last view never changes provider runtime state.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Locator {
    provider: String,
    session_type: String,
    session_id: String,
}

#[derive(Debug, Clone)]
struct PendingCreate {
    view_id: String,
}

#[derive(Debug, Default)]
pub(crate) struct FreshAgentViewRoutes {
    uses_view_ids: bool,
    pending_creates: HashMap<String, PendingCreate>,
    views: HashMap<Locator, HashSet<String>>,
}

impl FreshAgentViewRoutes {
    /// Record modern create/attach/detach traffic before provider dispatch.
    /// Older clients omit `viewId` and retain the pre-routing global fanout.
    pub(crate) fn observe_client_value(&mut self, value: &Value) {
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return;
        };
        let Some(view_id) = value.get("viewId").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "freshAgent.create" => {
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                self.uses_view_ids = true;
                self.pending_creates.insert(
                    request_id.to_string(),
                    PendingCreate {
                        view_id: view_id.to_string(),
                    },
                );
            }
            "freshAgent.attach" => {
                let Some(locator) = locator_from(value, "sessionId") else {
                    return;
                };
                self.uses_view_ids = true;
                self.views
                    .entry(locator)
                    .or_default()
                    .insert(view_id.to_string());
            }
            "freshAgent.detach" => {
                self.uses_view_ids = true;
                self.detach_view(view_id);
            }
            _ => {}
        }
    }

    /// Remove a view only from this connection. Repeated and unknown view ids
    /// are harmless, including when the target locator is not yet known.
    pub(crate) fn detach_view(&mut self, view_id: &str) {
        self.pending_creates
            .retain(|_, pending| pending.view_id != view_id);
        self.views.retain(|_, views| {
            views.remove(view_id);
            !views.is_empty()
        });
    }

    pub(crate) fn forget_create(&mut self, request_id: &str) {
        self.pending_creates.remove(request_id);
    }

    /// Apply requester-scoped routing to a received broadcast. A created
    /// response completes its own pending request and installs the resulting
    /// locator before the next ordered broadcast is considered.
    pub(crate) fn should_deliver(&mut self, json: &str) -> bool {
        let Ok(value) = serde_json::from_str::<Value>(json) else {
            return true;
        };
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return true;
        };
        if !kind.starts_with("freshAgent.") {
            return true;
        }

        match kind {
            "freshAgent.created" => {
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                if let Some(pending) = self.pending_creates.remove(request_id) {
                    if let Some(locator) = locator_from(&value, "sessionId") {
                        self.views
                            .entry(locator)
                            .or_default()
                            .insert(pending.view_id);
                    }
                    return true;
                }
                !self.uses_view_ids
            }
            "freshAgent.create.failed" => {
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                if self.pending_creates.remove(request_id).is_some() {
                    return true;
                }
                !self.uses_view_ids
            }
            "freshAgent.session.materialized" => {
                let Some(previous) = locator_from(&value, "previousSessionId") else {
                    return !self.uses_view_ids;
                };
                let Some(next) = locator_from(&value, "sessionId") else {
                    return self.views.contains_key(&previous) || !self.uses_view_ids;
                };
                let Some(views) = self.views.remove(&previous) else {
                    return !self.uses_view_ids;
                };
                self.views
                    .entry(next)
                    .or_default()
                    .extend(views.iter().cloned());
                true
            }
            "freshAgent.forked" => {
                let Some(parent) = locator_from(&value, "parentSessionId") else {
                    return !self.uses_view_ids;
                };
                let Some(views) = self.views.get(&parent).cloned() else {
                    return !self.uses_view_ids;
                };
                if let Some(next) = locator_from(&value, "sessionId") {
                    self.views.entry(next).or_default().extend(views);
                }
                true
            }
            _ => {
                let Some(locator) = locator_from_event(&value) else {
                    return !self.uses_view_ids;
                };
                self.views.contains_key(&locator) || !self.uses_view_ids
            }
        }
    }
}

fn locator_from(value: &Value, session_id_key: &str) -> Option<Locator> {
    Some(Locator {
        provider: value.get("provider")?.as_str()?.to_string(),
        session_type: value.get("sessionType")?.as_str()?.to_string(),
        session_id: value.get(session_id_key)?.as_str()?.to_string(),
    })
}

fn locator_from_event(value: &Value) -> Option<Locator> {
    if let Some(locator) = locator_from(value, "sessionId") {
        return Some(locator);
    }
    let event = value.get("event")?;
    let mut outer = value.clone();
    if outer.get("sessionId").is_none() {
        outer["sessionId"] = event.get("sessionId")?.clone();
    }
    locator_from(&outer, "sessionId")
}

#[cfg(test)]
mod tests {
    use super::FreshAgentViewRoutes;
    use serde_json::json;

    fn frame(value: serde_json::Value) -> String {
        value.to_string()
    }

    #[test]
    fn create_ack_installs_only_its_requesting_view() {
        let mut routes = FreshAgentViewRoutes::default();
        routes.observe_client_value(&json!({
            "type":"freshAgent.create", "requestId":"create-a", "viewId":"view-a"
        }));
        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"create-b", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"shared"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"create-a", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"shared"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"shared", "event":{"type":"freshAgent.stream"}
        }))));
        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"other", "event":{"type":"freshAgent.stream"}
        }))));
    }

    #[test]
    fn detaching_one_of_two_views_keeps_delivery_for_the_other() {
        let mut routes = FreshAgentViewRoutes::default();
        for view_id in ["view-a", "view-b"] {
            routes.observe_client_value(&json!({
                "type":"freshAgent.attach", "provider":"codex", "sessionType":"freshcodex",
                "sessionId":"shared", "viewId":view_id
            }));
        }
        routes.observe_client_value(&json!({
            "type":"freshAgent.detach", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"shared", "viewId":"view-a", "requestId":"detach-a"
        }));
        assert!(!routes.views.values().any(|views| views.contains("view-a")));
        assert!(routes.views.values().any(|views| views.contains("view-b")));
        let event = frame(json!({
            "type":"freshAgent.killed", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"shared", "success":true
        }));
        assert!(routes.should_deliver(&event));
        routes.detach_view("view-b");
        assert!(!routes.should_deliver(&event));
        routes.detach_view("view-b");
    }

    #[test]
    fn detaching_a_pending_create_suppresses_its_late_ack_and_events() {
        let mut routes = FreshAgentViewRoutes::default();
        routes.observe_client_value(&json!({
            "type":"freshAgent.create", "requestId":"create-cancelled", "viewId":"view-cancelled"
        }));
        routes.observe_client_value(&json!({
            "type":"freshAgent.detach", "requestId":"detach-cancelled", "viewId":"view-cancelled"
        }));

        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"create-cancelled", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"late-session"
        }))));
        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"late-session", "event":{"type":"freshAgent.stream"}
        }))));
    }

    #[test]
    fn legacy_connections_keep_global_fresh_agent_fanout() {
        let mut routes = FreshAgentViewRoutes::default();
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"legacy", "event":{}
        }))));
    }

    #[test]
    fn materialization_rekeys_the_attached_view() {
        let mut routes = FreshAgentViewRoutes::default();
        routes.observe_client_value(&json!({
            "type":"freshAgent.attach", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"temporary", "viewId":"view-a"
        }));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.session.materialized", "provider":"codex",
            "sessionType":"freshcodex", "previousSessionId":"temporary", "sessionId":"stable"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"stable", "event":{}
        }))));
    }
}
