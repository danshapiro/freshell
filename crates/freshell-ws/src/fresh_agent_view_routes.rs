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

#[derive(Debug, Clone)]
struct PendingFork {
    parent: Locator,
}

#[derive(Debug, Default)]
pub(crate) struct FreshAgentViewRoutes {
    uses_view_ids: bool,
    fresh_agent_reconciliation_v1: bool,
    pending_creates: HashMap<(String, String), PendingCreate>,
    pending_forks: HashMap<(String, String), PendingFork>,
    views: HashMap<Locator, HashSet<String>>,
}

impl FreshAgentViewRoutes {
    pub(crate) fn negotiate_fresh_agent_reconciliation_v1(&mut self) {
        self.fresh_agent_reconciliation_v1 = true;
        // V1 clients identify each pane by viewId during reconciliation,
        // before they send any direct attach/create frames. Scope request
        // acknowledgments from the handshake so a foreign create failure
        // cannot leak to a reconnecting V1 view during that gap.
        self.uses_view_ids = true;
    }

    pub(crate) fn fresh_agent_reconciliation_v1(&self) -> bool {
        self.fresh_agent_reconciliation_v1
    }

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
                    (request_id.to_string(), view_id.to_string()),
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
            "freshAgent.fork" => {
                self.uses_view_ids = true;
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    return;
                };
                let Some(parent) = locator_from(value, "sessionId") else {
                    return;
                };
                if self
                    .views
                    .get(&parent)
                    .is_some_and(|views| views.contains(view_id))
                {
                    self.pending_forks.insert(
                        (request_id.to_string(), view_id.to_string()),
                        PendingFork { parent },
                    );
                }
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
        self.pending_forks
            .retain(|(_, pending_view_id), _| pending_view_id != view_id);
        self.views.retain(|_, views| {
            views.remove(view_id);
            !views.is_empty()
        });
    }

    pub(crate) fn forget_create(&mut self, request_id: &str, view_id: Option<&str>) {
        if let Some(view_id) = view_id {
            self.pending_creates
                .remove(&(request_id.to_string(), view_id.to_string()));
        }
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
                let Some(view_id) = value.get("viewId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                if let Some(pending) = self
                    .pending_creates
                    .remove(&(request_id.to_string(), view_id.to_string()))
                {
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
                let Some(view_id) = value.get("viewId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                if self
                    .pending_creates
                    .remove(&(request_id.to_string(), view_id.to_string()))
                    .is_some()
                {
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
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                let Some(view_id) = value.get("viewId").and_then(Value::as_str) else {
                    return !self.uses_view_ids;
                };
                let key = (request_id.to_string(), view_id.to_string());
                let Some(pending) = self.pending_forks.get(&key) else {
                    return !self.uses_view_ids;
                };
                let Some(parent) = locator_from(&value, "parentSessionId") else {
                    return false;
                };
                if pending.parent != parent
                    || !self
                        .views
                        .get(&parent)
                        .is_some_and(|views| views.contains(view_id))
                {
                    return false;
                }
                let Some(child) = locator_from(&value, "sessionId") else {
                    return false;
                };
                self.pending_forks.remove(&key);
                self.views
                    .entry(child)
                    .or_default()
                    .insert(view_id.to_string());
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
            "sessionType":"freshcodex", "sessionId":"shared", "viewId":"view-a"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"create-a", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"shared", "viewId":"view-a"
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
    fn reused_request_ids_are_routed_by_the_echoed_view_id() {
        let mut routes = FreshAgentViewRoutes::default();
        for view_id in ["view-old", "view-new"] {
            routes.observe_client_value(&json!({
                "type":"freshAgent.create", "requestId":"reused", "viewId":view_id
            }));
        }

        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"reused", "viewId":"other-view",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"stale"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"reused", "viewId":"view-old",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"old-session"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"reused", "viewId":"view-new",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"new-session"
        }))));
        assert!(routes.views.contains_key(&super::Locator {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "old-session".into(),
        }));
        assert!(routes.views.contains_key(&super::Locator {
            provider: "codex".into(),
            session_type: "freshcodex".into(),
            session_id: "new-session".into(),
        }));
    }

    #[test]
    fn reused_request_ids_route_create_failures_by_the_echoed_view_id() {
        let mut routes = FreshAgentViewRoutes::default();
        for view_id in ["view-old", "view-new"] {
            routes.observe_client_value(&json!({
                "type":"freshAgent.create", "requestId":"reused", "viewId":view_id
            }));
        }

        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.create.failed", "requestId":"reused", "viewId":"other-view",
            "code":"CREATE_FAILED", "message":"stale"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.create.failed", "requestId":"reused", "viewId":"view-old",
            "code":"CREATE_FAILED", "message":"old view failed"
        }))));
        assert!(routes
            .pending_creates
            .contains_key(&("reused".into(), "view-new".into())));
    }

    #[test]
    fn negotiated_reconcile_clients_scope_foreign_create_failures_before_attach() {
        let mut routes = FreshAgentViewRoutes::default();
        routes.negotiate_fresh_agent_reconciliation_v1();

        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.create.failed", "requestId":"other-view-create",
            "viewId":"other-view", "code":"CLAUDE_ATTACH_RESUME_FAILED"
        }))));

        routes.observe_client_value(&json!({
            "type":"freshAgent.create", "requestId":"this-view-create", "viewId":"this-view"
        }));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.create.failed", "requestId":"this-view-create",
            "viewId":"this-view", "code":"CLAUDE_ATTACH_RESUME_FAILED"
        }))));
    }

    #[test]
    fn forgetting_a_create_keeps_another_view_with_the_same_request_id() {
        let mut routes = FreshAgentViewRoutes::default();
        for view_id in ["view-old", "view-new"] {
            routes.observe_client_value(&json!({
                "type":"freshAgent.create", "requestId":"reused", "viewId":view_id
            }));
        }

        routes.forget_create("reused", Some("view-old"));

        assert!(!routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"reused", "viewId":"view-old",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"old-session"
        }))));
        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.created", "requestId":"reused", "viewId":"view-new",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"new-session"
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
    fn hosted_fork_routes_child_events_only_to_the_exact_requesting_view() {
        let parent = json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"parent"
        });
        let mut requester = FreshAgentViewRoutes::default();
        let mut sibling = FreshAgentViewRoutes::default();
        let mut replacement = FreshAgentViewRoutes::default();

        for (routes, view_id) in [
            (&mut requester, "requester-view"),
            (&mut sibling, "sibling-view"),
            (&mut replacement, "replacement-view"),
        ] {
            let mut attach = parent.clone();
            attach["type"] = "freshAgent.attach".into();
            attach["viewId"] = view_id.into();
            routes.observe_client_value(&attach);
        }

        requester.observe_client_value(&json!({
            "type":"freshAgent.fork", "requestId":"reused-fork-id",
            "viewId":"requester-view", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"parent"
        }));

        // A replacement can reuse the request ID, but its different view must
        // not inherit a child route from the requester's result.
        let replacement_result = frame(json!({
            "type":"freshAgent.forked", "requestId":"reused-fork-id",
            "viewId":"replacement-view", "parentSessionId":"parent",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"stale-child"
        }));
        assert!(!requester.should_deliver(&replacement_result));
        assert!(!replacement.should_deliver(&replacement_result));
        assert!(!sibling.should_deliver(&replacement_result));
        let stale_child_event = frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"stale-child", "event":{"type":"freshAgent.stream"}
        }));
        assert!(!requester.should_deliver(&stale_child_event));
        assert!(!replacement.should_deliver(&stale_child_event));
        assert!(!sibling.should_deliver(&stale_child_event));

        // Even the exact pair cannot route a reply for a different parent.
        assert!(!requester.should_deliver(&frame(json!({
            "type":"freshAgent.forked", "requestId":"reused-fork-id",
            "viewId":"requester-view", "parentSessionId":"other-parent",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"wrong-parent-child"
        }))));
        assert!(!requester.should_deliver(&frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"wrong-parent-child", "event":{"type":"freshAgent.stream"}
        }))));

        let requester_result = frame(json!({
            "type":"freshAgent.forked", "requestId":"reused-fork-id",
            "viewId":"requester-view", "parentSessionId":"parent",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"requester-child"
        }));
        assert!(requester.should_deliver(&requester_result));
        assert!(!sibling.should_deliver(&requester_result));
        assert!(!replacement.should_deliver(&requester_result));

        let requester_child_event = frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"requester-child", "event":{"type":"freshAgent.stream"}
        }));
        assert!(requester.should_deliver(&requester_child_event));
        assert!(!sibling.should_deliver(&requester_child_event));
        assert!(!replacement.should_deliver(&requester_child_event));

        // A second view may legitimately reuse the same request ID. The exact
        // pair still routes its own child without changing the sibling route.
        replacement.observe_client_value(&json!({
            "type":"freshAgent.fork", "requestId":"reused-fork-id",
            "viewId":"replacement-view", "provider":"codex",
            "sessionType":"freshcodex", "sessionId":"parent"
        }));
        let replacement_fork_result = frame(json!({
            "type":"freshAgent.forked", "requestId":"reused-fork-id",
            "viewId":"replacement-view", "parentSessionId":"parent",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"replacement-child"
        }));
        assert!(!requester.should_deliver(&replacement_fork_result));
        assert!(!sibling.should_deliver(&replacement_fork_result));
        assert!(replacement.should_deliver(&replacement_fork_result));
        let replacement_child_event = frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"replacement-child", "event":{"type":"freshAgent.stream"}
        }));
        assert!(!requester.should_deliver(&replacement_child_event));
        assert!(!sibling.should_deliver(&replacement_child_event));
        assert!(replacement.should_deliver(&replacement_child_event));

        // Forking does not consume the parent's route, so the sibling still
        // receives authoritative parent retirement after the fork response.
        let parent_exit = frame(json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"parent", "event":{"type":"freshAgent.exit"}
        }));
        assert!(sibling.should_deliver(&parent_exit));
    }

    #[test]
    fn legacy_fork_without_view_id_keeps_global_fanout_without_route_mutation() {
        let mut routes = FreshAgentViewRoutes::default();

        assert!(routes.should_deliver(&frame(json!({
            "type":"freshAgent.forked", "parentSessionId":"parent",
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"child"
        }))));
        assert!(routes.views.is_empty());
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
