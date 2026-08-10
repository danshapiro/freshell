//! Pane/tab target resolution (pure model) — port of `server/agent-api/target-resolver.ts:41-93`
//! plus the empty-store guard of `LayoutStore.resolveTarget` (`layout-store.ts:426-429`).

use std::collections::HashMap;

use crate::layout_store::{LayoutStore, UiSnapshot};
use crate::layout_tree::PaneNode;

const AMBIGUOUS_PANE_TARGET_MESSAGE: &str =
    "pane target is ambiguous; use pane id or tab.pane index";
const TAB_MATCHED_MESSAGE: &str = "tab matched; active pane used";
const PANE_NOT_FOUND_MESSAGE: &str = "pane not found; active pane used";
const ACTIVE_TAB_MESSAGE: &str = "active tab used";

/// The Node `ResolveResult` split by outcome: a resolved pane, an ambiguous
/// pane-title match (HTTP 409 in the router), or nothing (HTTP 404).
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedTarget {
    Pane {
        tab_id: String,
        pane_id: String,
        message: Option<&'static str>,
    },
    Ambiguous(&'static str),
    NotFound(&'static str),
}

/// Resolution order (`target-resolver.ts:41-93`):
/// exact pane id -> exact tab id OR tab title (that tab's active pane) ->
/// `tab.pane` / `session:window.pane` index form -> bare numeric index into
/// the active tab -> pane title across all tabs (2+ matches -> Ambiguous) ->
/// NotFound. An empty store short-circuits to `NotFound("no layout snapshot")`.
pub fn resolve_target(store: &LayoutStore, raw: &str) -> ResolvedTarget {
    let Some(snapshot) = store.snapshot_clone() else {
        return ResolvedTarget::NotFound("no layout snapshot");
    };
    let clean = raw.trim();
    if clean.is_empty() {
        return ResolvedTarget::NotFound("target not resolved");
    }

    // buildPaneIndex (target-resolver.ts:27-39).
    let mut pane_to_tab: HashMap<String, String> = HashMap::new();
    let mut panes_by_tab: Vec<(String, Vec<String>)> = Vec::new();
    for tab in &snapshot.tabs {
        let mut pane_ids = Vec::new();
        if let Some(root) = snapshot.layouts.get(&tab.id) {
            let mut leaves = Vec::new();
            root.collect_leaves(&mut leaves);
            for leaf in leaves {
                if let PaneNode::Leaf { id, .. } = leaf {
                    pane_to_tab.insert(id.clone(), tab.id.clone());
                    pane_ids.push(id.clone());
                }
            }
        }
        panes_by_tab.push((tab.id.clone(), pane_ids));
    }

    // Exact pane id (:47-49).
    if let Some(tab_id) = pane_to_tab.get(clean) {
        return ResolvedTarget::Pane {
            tab_id: tab_id.clone(),
            pane_id: clean.to_string(),
            message: None,
        };
    }

    // Exact tab id or title -> that tab's active pane (:51-55). No recorded
    // active pane == Node's `paneId: undefined` (the router 404s with the
    // same message).
    if let Some(tab) = snapshot
        .tabs
        .iter()
        .find(|t| t.id == clean || t.title.as_deref() == Some(clean))
    {
        return match snapshot.active_pane.get(&tab.id) {
            Some(pane_id) => ResolvedTarget::Pane {
                tab_id: tab.id.clone(),
                pane_id: pane_id.clone(),
                message: Some(TAB_MATCHED_MESSAGE),
            },
            None => ResolvedTarget::NotFound(TAB_MATCHED_MESSAGE),
        };
    }

    // `tab.pane` or `session:window.pane` (:57-70). No match falls through.
    if clean.contains('.') {
        let no_session = match clean.split_once(':') {
            Some((_, rest)) => rest,
            None => clean,
        };
        let mut parts = no_session.split('.');
        let tab_part = parts.next().unwrap_or("");
        // `Number(undefined)` is NaN -> skip; `Number('')` is 0 -> js_number.
        if let Some(index) = parts.next().and_then(js_number) {
            if let Some(tab) = snapshot
                .tabs
                .iter()
                .find(|t| t.id == tab_part || t.title.as_deref() == Some(tab_part))
            {
                let leaves = leaves_for(&panes_by_tab, &tab.id);
                return match leaf_at(leaves, index) {
                    Some(pane_id) => ResolvedTarget::Pane {
                        tab_id: tab.id.clone(),
                        pane_id: pane_id.clone(),
                        message: None,
                    },
                    None => ResolvedTarget::NotFound(PANE_NOT_FOUND_MESSAGE),
                };
            }
        }
    }

    // Bare numeric pane index into the active tab (:72-81).
    let active_tab_id = snapshot
        .active_tab_id
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| snapshot.tabs.first().map(|t| t.id.clone()));
    if let Some(active_tab_id) = active_tab_id {
        if let Some(index) = js_number(clean) {
            let leaves = leaves_for(&panes_by_tab, &active_tab_id);
            return match leaf_at(leaves, index) {
                Some(pane_id) => ResolvedTarget::Pane {
                    tab_id: active_tab_id,
                    pane_id: pane_id.clone(),
                    message: Some(ACTIVE_TAB_MESSAGE),
                },
                None => ResolvedTarget::NotFound(ACTIVE_TAB_MESSAGE),
            };
        }
    }

    // Pane title across all tabs; the second match is ambiguous (:83-91).
    let mut title_match: Option<(String, String)> = None;
    for (tab_id, pane_ids) in &panes_by_tab {
        for pane_id in pane_ids {
            if pane_title(&snapshot, tab_id, pane_id) != Some(clean) {
                continue;
            }
            if title_match.is_some() {
                return ResolvedTarget::Ambiguous(AMBIGUOUS_PANE_TARGET_MESSAGE);
            }
            title_match = Some((tab_id.clone(), pane_id.clone()));
        }
    }
    if let Some((tab_id, pane_id)) = title_match {
        return ResolvedTarget::Pane {
            tab_id,
            pane_id,
            message: None,
        };
    }

    ResolvedTarget::NotFound("target not resolved")
}

fn pane_title<'a>(snapshot: &'a UiSnapshot, tab_id: &str, pane_id: &str) -> Option<&'a str> {
    snapshot
        .pane_titles
        .get(tab_id)
        .and_then(|titles| titles.get(pane_id))
        .map(String::as_str)
}

fn leaves_for<'a>(panes_by_tab: &'a [(String, Vec<String>)], tab_id: &str) -> &'a [String] {
    panes_by_tab
        .iter()
        .find(|(id, _)| id == tab_id)
        .map(|(_, leaves)| leaves.as_slice())
        .unwrap_or(&[])
}

/// `leaves[idx]` under JS indexing: only a non-negative integral index within
/// range hits (`leaves[1.5]` / `leaves[-1]` are `undefined`).
fn leaf_at(leaves: &[String], index: f64) -> Option<&String> {
    if index < 0.0 || index.fract() != 0.0 {
        return None;
    }
    leaves.get(index as usize)
}

/// `Number(value)` for the index forms: trimmed empty string -> 0, otherwise a
/// finite float parse (`Infinity`/garbage -> None, mirroring `Number.isFinite`).
fn js_number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout_store::LayoutStore;
    use freshell_protocol::UiLayoutSync;
    use serde_json::json;

    fn seeded_store() -> LayoutStore {
        let store = LayoutStore::default();
        let sync: UiLayoutSync = serde_json::from_value(json!({
            "tabs": [
                { "id": "t1", "title": "First" },
                { "id": "t2", "title": "Second" },
            ],
            "activeTabId": "t1",
            "layouts": {
                "t1": {
                    "type": "split",
                    "id": "s1",
                    "direction": "horizontal",
                    "sizes": [50, 50],
                    "children": [
                        { "type": "leaf", "id": "p1", "content": { "kind": "picker" } },
                        { "type": "leaf", "id": "p2", "content": { "kind": "picker" } },
                    ],
                },
                "t2": { "type": "leaf", "id": "p3", "content": { "kind": "picker" } },
            },
            "activePane": { "t1": "p2", "t2": "p3" },
            "paneTitles": { "t1": { "p1": "Build", "p2": "Logs" }, "t2": { "p3": "Build" } },
            "timestamp": 1,
        }))
        .expect("UiLayoutSync parses");
        store.update_from_ui(&sync, "conn-test");
        store
    }

    fn pane(tab_id: &str, pane_id: &str, message: Option<&'static str>) -> ResolvedTarget {
        ResolvedTarget::Pane {
            tab_id: tab_id.to_string(),
            pane_id: pane_id.to_string(),
            message,
        }
    }

    #[test]
    fn resolves_pane_id_tab_id_tab_title_index_form_and_ambiguous_pane_title() {
        let store = seeded_store();

        // Rung 1: exact pane id (target-resolver.ts:47-49); input is trimmed (:42).
        assert_eq!(resolve_target(&store, "p1"), pane("t1", "p1", None));
        assert_eq!(resolve_target(&store, "  p1  "), pane("t1", "p1", None));

        // Rung 2: exact tab id OR tab title -> that tab's active pane (:51-55).
        assert_eq!(
            resolve_target(&store, "t2"),
            pane("t2", "p3", Some("tab matched; active pane used"))
        );
        assert_eq!(
            resolve_target(&store, "First"),
            pane("t1", "p2", Some("tab matched; active pane used"))
        );

        // Rung 3: tab.pane / session:window.pane index form (:57-70).
        assert_eq!(resolve_target(&store, "t1.1"), pane("t1", "p2", None));
        assert_eq!(resolve_target(&store, "sess:t1.0"), pane("t1", "p1", None));
        assert_eq!(resolve_target(&store, "First.0"), pane("t1", "p1", None));
        assert_eq!(
            resolve_target(&store, "t1.9"),
            ResolvedTarget::NotFound("pane not found; active pane used")
        );

        // Rung 4: bare numeric index into the active tab (:72-81).
        assert_eq!(
            resolve_target(&store, "0"),
            pane("t1", "p1", Some("active tab used"))
        );
        assert_eq!(
            resolve_target(&store, "1"),
            pane("t1", "p2", Some("active tab used"))
        );
        assert_eq!(
            resolve_target(&store, "9"),
            ResolvedTarget::NotFound("active tab used")
        );

        // Rung 5: pane title across all tabs; 2+ matches -> Ambiguous (:83-91).
        assert_eq!(resolve_target(&store, "Logs"), pane("t1", "p2", None));
        assert_eq!(
            resolve_target(&store, "Build"),
            ResolvedTarget::Ambiguous("pane target is ambiguous; use pane id or tab.pane index")
        );

        // Fallthrough + degenerate inputs (:43, :93).
        assert_eq!(
            resolve_target(&store, "zzz"),
            ResolvedTarget::NotFound("target not resolved")
        );
        assert_eq!(
            resolve_target(&store, "   "),
            ResolvedTarget::NotFound("target not resolved")
        );

        // Empty store (layout-store.ts:426-429).
        assert_eq!(
            resolve_target(&LayoutStore::default(), "p1"),
            ResolvedTarget::NotFound("no layout snapshot")
        );
    }
}
