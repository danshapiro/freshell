//! Keep a server-created pane addressable until the browser observes its
//! announcement. Merge only that creation into an older browser layout.

use super::*;

pub(super) struct PendingPublication {
    pub tab_id: String,
    pub pane_id: String,
    pub placement: Placement,
    pub published: bool,
    pub create_request_id: Option<String>,
}

pub(super) enum Placement {
    Tab,
    Split {
        source_pane_id: String,
        split_node_id: String,
        direction: String,
    },
}

pub(super) fn preserve(
    inner: &mut LayoutInner,
    incoming: &mut UiSnapshot,
    observed_panes: &std::collections::HashSet<String>,
) {
    let mut pending = std::mem::take(&mut inner.pending_publications);
    pending.retain(|entry| !(entry.published && observed_panes.contains(&entry.pane_id)));
    for entry in &pending {
        if pane_content_in_snapshot(incoming, &entry.pane_id).is_some() {
            continue;
        }
        let Some(current) = inner
            .snapshots()
            .find(|snapshot| pane_content_in_snapshot(snapshot, &entry.pane_id).is_some())
        else {
            continue;
        };
        let Some(content) = pane_content_in_snapshot(current, &entry.pane_id) else {
            continue;
        };
        let leaf = PaneNode::Leaf {
            id: entry.pane_id.clone(),
            content: content.clone(),
        };
        let merged = match &entry.placement {
            Placement::Tab => {
                if incoming.tabs.iter().any(|tab| tab.id == entry.tab_id) {
                    false
                } else if let Some(tab) = current.tabs.iter().find(|tab| tab.id == entry.tab_id) {
                    incoming.tabs.push(tab.clone());
                    incoming.layouts.insert(entry.tab_id.clone(), leaf);
                    incoming
                        .active_pane
                        .insert(entry.tab_id.clone(), entry.pane_id.clone());
                    true
                } else {
                    false
                }
            }
            Placement::Split {
                source_pane_id,
                split_node_id,
                direction,
            } => {
                let Some(root) = incoming.layouts.get_mut(&entry.tab_id) else {
                    continue;
                };
                let Some(source) = root.find_leaf(source_pane_id).cloned() else {
                    continue;
                };
                replace_node(
                    root,
                    source_pane_id,
                    &PaneNode::Split {
                        id: split_node_id.clone(),
                        direction: direction.clone(),
                        sizes: [50.0, 50.0],
                        children: Box::new([source, leaf]),
                    },
                )
            }
        };
        if merged {
            seed_pane_title(incoming, &entry.tab_id, &entry.pane_id, &content);
            tracing::debug!(
                event = "agent_api.layout_creation_preserved",
                tab_id = %entry.tab_id,
                pane_id = %entry.pane_id,
                published = entry.published,
                "preserved a server-created pane across a pre-announcement layout sync"
            );
        }
    }
    inner.pending_publications = pending;
}

impl LayoutStore {
    pub(crate) fn set_pending_create_request(&self, pane_id: &str, request_id: &str) -> bool {
        let mut inner = self.lock();
        let Some(entry) = inner
            .pending_publications
            .iter_mut()
            .find(|entry| entry.pane_id == pane_id)
        else {
            return false;
        };
        entry.create_request_id = Some(request_id.to_string());
        true
    }

    pub(crate) fn finish_pending_pane(&self, tab_id: &str, pane_id: &str, content: Value) -> bool {
        let mut inner = self.lock();
        if !inner
            .pending_publications
            .iter()
            .any(|entry| entry.pane_id == pane_id)
            || !inner.snapshots().any(|snapshot| {
                snapshot
                    .layouts
                    .get(tab_id)
                    .and_then(|root| root.find_leaf(pane_id))
                    .is_some()
            })
        {
            inner
                .pending_publications
                .retain(|entry| entry.pane_id != pane_id);
            return false;
        }
        Self::attach_pane_content_locked(&mut inner, tab_id, pane_id, content);
        if let Some(entry) = inner
            .pending_publications
            .iter_mut()
            .find(|entry| entry.pane_id == pane_id)
        {
            entry.published = true;
        }
        true
    }

    /// `pane.closed` is acknowledged before the browser removes its leaf.
    /// Release publication authority first so its next layout sync can close it.
    pub fn release_pane_publication(&self, create_request_id: &str) {
        let mut inner = self.lock();
        let released: std::collections::HashSet<_> = inner.pending_publications.iter().filter(|entry| {
            entry.create_request_id.as_deref() == Some(create_request_id)
                || (!entry.published && matches!(&entry.placement, Placement::Split { source_pane_id, .. }
                    if inner.snapshots().find_map(|snapshot| pane_content_in_snapshot(snapshot, source_pane_id))
                        .is_some_and(|content| content.get("createRequestId").and_then(Value::as_str) == Some(create_request_id))))
        }).map(|entry| entry.pane_id.clone()).collect();
        inner
            .pending_publications
            .retain(|entry| !released.contains(&entry.pane_id));
    }
}
