//! Server-side UiSnapshot mirror (pure model).
//!
//! Port of `server/agent-api/layout-store.ts` — the layout snapshot the REST
//! automation surface reads and mutates. Pure model: no axum, no broadcasts;
//! Tasks 13-16 wire this into the REST routes and `ui.layout.sync` handling.
//!
//! The legacy fresh-agent content migration (`normalizeLayouts` /
//! `normalizePaneContentSnapshot`, `layout-store.ts:29-38`) is ported from
//! `shared/fresh-agent.ts:199-360` + `shared/session-contract.ts:34-62` at the
//! bottom of this file.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::layout_tree::{build_grid_layout, replace_node, PaneNode};
use crate::target_resolver::{resolve_target, ResolvedTarget};

#[path = "layout_store_content.rs"]
mod content;
pub use content::{derive_pane_title, is_valid_percent, normalize_pair_to_hundred};
use content::{migrate_legacy_fresh_agent_content, migrate_legacy_fresh_agent_node};

/// One ORDERED tab row (`UiSnapshot.tabs`, `layout-store.ts:7`).
#[derive(Clone, Debug, Default)]
pub struct TabRow {
    pub id: String,
    pub title: Option<String>,
    /// Opaque `SessionLocator` carried through verbatim.
    pub fallback_session_ref: Option<Value>,
}

/// The server-side mirror of the client's layout snapshot
/// (`layout-store.ts:6-14`).
#[derive(Clone, Debug, Default)]
pub struct UiSnapshot {
    /// ORDERED — tab order drives next/prev cycling and pane indexes.
    pub tabs: Vec<TabRow>,
    pub active_tab_id: Option<String>,
    /// tabId -> layout root.
    pub layouts: HashMap<String, PaneNode>,
    /// tabId -> active paneId.
    pub active_pane: HashMap<String, String>,
    /// tabId -> paneId -> title.
    pub pane_titles: HashMap<String, HashMap<String, String>>,
    /// tabId -> paneId -> sticky flag (user-set titles survive re-seeding).
    pub pane_title_set_by_user: HashMap<String, HashMap<String, bool>>,
    pub timestamp: Option<i64>,
}

#[derive(Default)]
struct LayoutInner {
    snapshot: Option<UiSnapshot>,
    source_connection_id: Option<String>,
}

/// Shared, cheaply-cloneable layout store (`LayoutStore`, `layout-store.ts:48`).
#[derive(Clone, Default)]
pub struct LayoutStore {
    inner: Arc<Mutex<LayoutInner>>,
}

/// Outcome of tab/pane mutations (the Node methods' `{ tabId?, paneId?, message? }`).
#[derive(Clone, Debug, PartialEq)]
pub struct RenameOutcome {
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    /// One of `"tab not found"`, `"pane not found"`, `"no layout snapshot"`.
    pub message: Option<&'static str>,
}

impl RenameOutcome {
    fn failed(message: &'static str) -> Self {
        Self {
            tab_id: None,
            pane_id: None,
            message: Some(message),
        }
    }

    fn tab(tab_id: &str) -> Self {
        Self {
            tab_id: Some(tab_id.to_string()),
            pane_id: None,
            message: None,
        }
    }

    fn tab_pane(tab_id: &str, pane_id: &str) -> Self {
        Self {
            tab_id: Some(tab_id.to_string()),
            pane_id: Some(pane_id.to_string()),
            message: None,
        }
    }
}

/// One `listPanes` row (`layout-store.ts:341-355`).
#[derive(Clone, Debug, PartialEq)]
pub struct PaneRow {
    pub id: String,
    /// Depth-first leaf index — the `tab.pane` index form's index.
    pub index: usize,
    pub kind: Option<String>,
    pub terminal_id: Option<String>,
    pub title: Option<String>,
}

/// One `getPaneSnapshot` result (`layout-store.ts:379-397`).
#[derive(Clone, Debug, PartialEq)]
pub struct PaneSnapshot {
    pub tab_id: String,
    pub pane_id: String,
    pub kind: Option<String>,
    pub terminal_id: Option<String>,
    pub pane_content: Option<Value>,
}

impl LayoutStore {
    fn lock(&self) -> MutexGuard<'_, LayoutInner> {
        self.inner.lock().expect("layout store mutex")
    }

    /// Clone of the current snapshot for read-only walkers (target resolver).
    pub(crate) fn snapshot_clone(&self) -> Option<UiSnapshot> {
        self.lock().snapshot.clone()
    }

    /// REPLACES the snapshot; runs the legacy fresh-agent migration on every
    /// layout node, then seeds a derived title per leaf
    /// (`updateFromUi`, `layout-store.ts:169-181`).
    pub fn update_from_ui(
        &self,
        sync: &freshell_protocol::UiLayoutSync,
        source_connection_id: &str,
    ) {
        let mut snapshot = UiSnapshot {
            tabs: sync
                .tabs
                .iter()
                .map(|tab| TabRow {
                    id: tab.id.clone(),
                    title: tab.title.clone(),
                    fallback_session_ref: tab
                        .fallback_session_ref
                        .as_ref()
                        .and_then(|locator| serde_json::to_value(locator).ok()),
                })
                .collect(),
            active_tab_id: sync.active_tab_id.clone().flatten(),
            layouts: HashMap::new(),
            active_pane: sync
                .active_pane
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            pane_titles: nested_string_map(sync.pane_titles.as_ref()),
            pane_title_set_by_user: nested_bool_map(sync.pane_title_set_by_user.as_ref()),
            timestamp: Some(sync.timestamp),
        };
        if let Some(layouts) = sync.layouts.as_object() {
            for (tab_id, node) in layouts {
                let migrated = migrate_legacy_fresh_agent_node(node);
                if let Some(parsed) = PaneNode::parse(&migrated) {
                    snapshot.layouts.insert(tab_id.clone(), parsed);
                }
            }
        }
        // Seed derived titles per leaf, in tab order (`layout-store.ts:175-180`).
        let tab_ids: Vec<String> = snapshot.tabs.iter().map(|t| t.id.clone()).collect();
        for tab_id in tab_ids {
            for (pane_id, content) in leaves_of(&snapshot, &tab_id) {
                seed_pane_title(&mut snapshot, &tab_id, &pane_id, &content);
            }
        }
        let mut inner = self.lock();
        inner.snapshot = Some(snapshot);
        inner.source_connection_id = Some(source_connection_id.to_string());
    }

    pub fn has_snapshot(&self) -> bool {
        self.lock().snapshot.is_some()
    }

    pub fn source_connection_id(&self) -> Option<String> {
        self.lock().source_connection_id.clone()
    }

    /// Exact Node keys: `tabs`/`activeTabId`/`layouts`/`activePane`/`paneTitles`/
    /// `paneTitleSetByUser`/`timestamp`; the empty snapshot when none
    /// (`getNormalizedSnapshot`, `layout-store.ts:44-46, 191-210`).
    pub fn get_normalized_snapshot(&self, tab_id: Option<&str>) -> Value {
        let inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_ref() else {
            return json!({
                "tabs": [],
                "layouts": {},
                "activePane": {},
                "activeTabId": null,
                "paneTitles": {},
                "paneTitleSetByUser": {},
            });
        };
        let Some(tab_id) = tab_id else {
            return snapshot_value(snapshot);
        };
        let tab = snapshot.tabs.iter().find(|t| t.id == tab_id);
        let mut out = Map::new();
        out.insert(
            "tabs".to_string(),
            Value::Array(tab.iter().map(|t| tab_row_value(t)).collect()),
        );
        out.insert(
            "activeTabId".to_string(),
            tab.map(|t| json!(t.id)).unwrap_or(Value::Null),
        );
        out.insert(
            "layouts".to_string(),
            match snapshot.layouts.get(tab_id) {
                Some(root) => json!({ tab_id: root.to_value() }),
                None => json!({}),
            },
        );
        out.insert(
            "activePane".to_string(),
            match snapshot.active_pane.get(tab_id) {
                Some(pane) => json!({ tab_id: pane }),
                None => json!({}),
            },
        );
        out.insert(
            "paneTitles".to_string(),
            match snapshot.pane_titles.get(tab_id) {
                Some(map) => json!({ tab_id: map }),
                None => json!({}),
            },
        );
        out.insert(
            "paneTitleSetByUser".to_string(),
            match snapshot.pane_title_set_by_user.get(tab_id) {
                Some(map) => json!({ tab_id: map }),
                None => json!({}),
            },
        );
        if let Some(ts) = snapshot.timestamp {
            out.insert("timestamp".to_string(), json!(ts));
        }
        Value::Object(out)
    }

    /// Rows `{id, title (falls back to id), activePaneId}` + the active tab id
    /// (`listTabs`, `layout-store.ts:327-334`; `getActiveTabId`, `:187-189`).
    pub fn list_tabs(&self) -> (Vec<Value>, Option<String>) {
        let inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_ref() else {
            return (Vec::new(), None);
        };
        let rows = snapshot
            .tabs
            .iter()
            .map(|tab| {
                let mut row = Map::new();
                row.insert("id".to_string(), json!(tab.id));
                row.insert(
                    "title".to_string(),
                    json!(tab
                        .title
                        .clone()
                        .filter(|t| !t.is_empty())
                        .unwrap_or_else(|| tab.id.clone())),
                );
                if let Some(pane) = snapshot.active_pane.get(&tab.id) {
                    row.insert("activePaneId".to_string(), json!(pane));
                }
                Value::Object(row)
            })
            .collect();
        (
            rows,
            snapshot.active_tab_id.clone().filter(|t| !t.is_empty()),
        )
    }

    /// Matches by tab id OR title (`hasTab`, `layout-store.ts:336-339`).
    pub fn has_tab(&self, target: &str) -> bool {
        let inner = self.lock();
        inner
            .snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .tabs
                    .iter()
                    .any(|t| t.id == target || t.title.as_deref() == Some(target))
            })
            .unwrap_or(false)
    }

    /// `ensureSnapshot` + append an ordered tab with a single terminal leaf and
    /// a seeded title (`createTab`, `layout-store.ts:431-460`).
    pub fn create_tab(&self, title: Option<&str>) -> (String, String) {
        let tab_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();
        // `buildContent({})` (`layout-store.ts:317-325`): a detached terminal pane.
        let content = json!({ "kind": "terminal" });
        let mut inner = self.lock();
        let snapshot = inner.snapshot.get_or_insert_with(UiSnapshot::default);
        snapshot.tabs.push(TabRow {
            id: tab_id.clone(),
            title: title.map(str::to_string),
            fallback_session_ref: None,
        });
        snapshot.layouts.insert(
            tab_id.clone(),
            PaneNode::Leaf {
                id: pane_id.clone(),
                content: content.clone(),
            },
        );
        snapshot.active_tab_id = Some(tab_id.clone());
        snapshot.active_pane.insert(tab_id.clone(), pane_id.clone());
        seed_pane_title(snapshot, &tab_id, &pane_id, &content);
        (tab_id, pane_id)
    }

    /// Purges layouts/activePane/title maps (`closeTab`, `layout-store.ts:577-587`
    /// + `removeTabMetadata`, `:87-91`).
    pub fn close_tab(&self, tab_id: &str) -> RenameOutcome {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return RenameOutcome::failed("no layout snapshot");
        };
        let before = snapshot.tabs.len();
        snapshot.tabs.retain(|t| t.id != tab_id);
        if snapshot.tabs.len() == before {
            return RenameOutcome::failed("tab not found");
        }
        snapshot.layouts.remove(tab_id);
        snapshot.active_pane.remove(tab_id);
        snapshot.pane_titles.remove(tab_id);
        snapshot.pane_title_set_by_user.remove(tab_id);
        snapshot.active_tab_id = snapshot.tabs.first().map(|t| t.id.clone());
        RenameOutcome::tab(tab_id)
    }

    /// `ensureSnapshot`; sets the active tab when it exists
    /// (`selectTab`, `layout-store.ts:518-524`).
    pub fn select_tab(&self, tab_id: &str) -> RenameOutcome {
        let mut inner = self.lock();
        let snapshot = inner.snapshot.get_or_insert_with(UiSnapshot::default);
        if !snapshot.tabs.iter().any(|t| t.id == tab_id) {
            return RenameOutcome::failed("tab not found");
        }
        snapshot.active_tab_id = Some(tab_id.to_string());
        RenameOutcome::tab(tab_id)
    }

    /// Ordered cycle modulo len (`selectNextTab`, `layout-store.ts:589-596`).
    pub fn select_next_tab(&self) -> Option<String> {
        self.cycle_tab(|current, len| match current {
            Some(i) => (i + 1) % len,
            None => 0,
        })
    }

    /// Ordered cycle modulo len (`selectPrevTab`, `layout-store.ts:598-607`).
    pub fn select_prev_tab(&self) -> Option<String> {
        self.cycle_tab(|current, len| match current {
            Some(i) => (i + len - 1) % len,
            None => 0,
        })
    }

    fn cycle_tab(&self, pick: impl Fn(Option<usize>, usize) -> usize) -> Option<String> {
        let mut inner = self.lock();
        let snapshot = inner.snapshot.as_mut()?;
        if snapshot.tabs.is_empty() {
            return None;
        }
        let current = snapshot
            .tabs
            .iter()
            .position(|t| Some(&t.id) == snapshot.active_tab_id.as_ref());
        let tab_id = snapshot.tabs[pick(current, snapshot.tabs.len())].id.clone();
        snapshot.active_tab_id = Some(tab_id.clone());
        Some(tab_id)
    }

    /// Sets the tab title; single-pane tabs mirror it into the pane title maps
    /// as sticky (`renameTab`, `layout-store.ts:542-556`).
    pub fn rename_tab(&self, tab_id: &str, title: &str) -> RenameOutcome {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return RenameOutcome::failed("no layout snapshot");
        };
        let Some(index) = snapshot.tabs.iter().position(|t| t.id == tab_id) else {
            return RenameOutcome::failed("tab not found");
        };
        snapshot.tabs[index].title = Some(title.to_string());
        // Node guard is `if (singlePaneId && title)` — empty titles don't mirror.
        if !title.is_empty() {
            if let Some(pane_id) = single_pane_id(snapshot, tab_id) {
                set_sticky_title(snapshot, tab_id, &pane_id, title);
            }
        }
        RenameOutcome::tab(tab_id)
    }

    /// Sets the pane title sticky; single-pane tabs mirror it onto the tab
    /// title (`renamePane`, `layout-store.ts:558-575`).
    pub fn rename_pane(&self, pane_id: &str, title: &str) -> RenameOutcome {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return RenameOutcome::failed("no layout snapshot");
        };
        let Some(tab_id) = find_pane_tab(snapshot, pane_id) else {
            return RenameOutcome::failed("pane not found");
        };
        set_sticky_title(snapshot, &tab_id, pane_id, title);
        if single_pane_id(snapshot, &tab_id).as_deref() == Some(pane_id) {
            if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == tab_id) {
                tab.title = Some(title.to_string());
            }
        }
        RenameOutcome::tab_pane(&tab_id, pane_id)
    }

    /// Default tab = active then first (`listPanes`, `layout-store.ts:341-355`).
    pub fn list_panes(&self, tab_id: Option<&str>) -> Result<Vec<PaneRow>, &'static str> {
        let inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_ref() else {
            return Err("no layout snapshot");
        };
        let resolved = tab_id
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .or_else(|| snapshot.active_tab_id.clone().filter(|t| !t.is_empty()))
            .or_else(|| snapshot.tabs.first().map(|t| t.id.clone()));
        let Some(resolved) = resolved else {
            return Ok(Vec::new());
        };
        Ok(leaves_of(snapshot, &resolved)
            .into_iter()
            .enumerate()
            .map(|(index, (id, content))| PaneRow {
                index,
                kind: string_field(&content, "kind"),
                terminal_id: string_field(&content, "terminalId"),
                title: snapshot
                    .pane_titles
                    .get(&resolved)
                    .and_then(|m| m.get(&id))
                    .cloned(),
                id,
            })
            .collect())
    }

    /// (`getPaneSnapshot`, `layout-store.ts:379-397`.)
    pub fn get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot> {
        let inner = self.lock();
        let snapshot = inner.snapshot.as_ref()?;
        let tab_id = find_pane_tab(snapshot, pane_id)?;
        let content = match snapshot.layouts.get(&tab_id)?.find_leaf(pane_id)? {
            PaneNode::Leaf { content, .. } => content.clone(),
            PaneNode::Split { .. } => return None,
        };
        Some(PaneSnapshot {
            tab_id,
            pane_id: pane_id.to_string(),
            kind: string_field(&content, "kind"),
            terminal_id: string_field(&content, "terminalId"),
            pane_content: (!content.is_null()).then_some(content),
        })
    }

    /// Binary split 50/50; the new pane becomes active and gets a seeded title
    /// (`splitPane`, `layout-store.ts:462-499`).
    pub fn split_pane(
        &self,
        pane_id: &str,
        direction: &str,
    ) -> Result<(String, String), &'static str> {
        let mut inner = self.lock();
        let snapshot = inner.snapshot.get_or_insert_with(UiSnapshot::default);
        let tab_ids: Vec<String> = snapshot.tabs.iter().map(|t| t.id.clone()).collect();
        for tab_id in tab_ids {
            let existing_content = match snapshot
                .layouts
                .get(&tab_id)
                .and_then(|root| root.find_leaf(pane_id))
            {
                Some(PaneNode::Leaf { content, .. }) => content.clone(),
                _ => continue,
            };
            let new_pane_id = Uuid::new_v4().to_string();
            let new_content = json!({ "kind": "terminal" });
            let split = PaneNode::Split {
                id: Uuid::new_v4().to_string(),
                direction: direction.to_string(),
                sizes: [50.0, 50.0],
                children: Box::new([
                    PaneNode::Leaf {
                        id: pane_id.to_string(),
                        content: existing_content,
                    },
                    PaneNode::Leaf {
                        id: new_pane_id.clone(),
                        content: new_content.clone(),
                    },
                ]),
            };
            let root = snapshot.layouts.get_mut(&tab_id).expect("root exists");
            if replace_node(root, pane_id, &split) {
                snapshot
                    .active_pane
                    .insert(tab_id.clone(), new_pane_id.clone());
                seed_pane_title(snapshot, &tab_id, &new_pane_id, &new_content);
                return Ok((tab_id, new_pane_id));
            }
        }
        Err("pane not found")
    }

    /// Re-seeds the derived title (non-sticky). Runs the legacy content
    /// migration first (`attachPaneContent`, `layout-store.ts:680-694`).
    pub fn attach_pane_content(
        &self,
        tab_id: &str,
        pane_id: &str,
        content: Value,
    ) -> RenameOutcome {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return RenameOutcome::failed("no layout snapshot");
        };
        let normalized = migrate_legacy_fresh_agent_content(&content);
        let Some(root) = snapshot.layouts.get_mut(tab_id) else {
            return RenameOutcome::failed("tab not found");
        };
        // Node's recursive update is a no-op for an absent pane but still
        // reports `{tabId, paneId}` — mirrored here (return value ignored).
        root.replace_leaf_content(pane_id, normalized.clone());
        seed_pane_title(snapshot, tab_id, pane_id, &normalized);
        RenameOutcome::tab_pane(tab_id, pane_id)
    }

    /// Pure tree mutation — never kills PTYs (`closePane`, `layout-store.ts:501-516`).
    pub fn close_pane(&self, pane_id: &str) -> Result<String, &'static str> {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return Err("no layout snapshot");
        };
        let tab_ids: Vec<String> = snapshot.tabs.iter().map(|t| t.id.clone()).collect();
        for tab_id in tab_ids {
            let Some(root) = snapshot.layouts.get(&tab_id) else {
                continue;
            };
            let mut leaves = Vec::new();
            root.collect_leaves(&mut leaves);
            let total = leaves.len();
            let remaining: Vec<PaneNode> = leaves
                .into_iter()
                .filter(|leaf| !matches!(leaf, PaneNode::Leaf { id, .. } if id == pane_id))
                .cloned()
                .collect();
            if remaining.len() == total {
                continue;
            }
            if remaining.is_empty() {
                return Err("cannot close only pane");
            }
            let last_id = match remaining.last() {
                Some(PaneNode::Leaf { id, .. }) => id.clone(),
                _ => return Err("pane not found"),
            };
            let rebuilt = build_grid_layout(remaining);
            snapshot.layouts.insert(tab_id.clone(), rebuilt);
            snapshot.active_pane.insert(tab_id.clone(), last_id);
            remove_pane_metadata(snapshot, &tab_id, pane_id);
            return Ok(tab_id);
        }
        Err("pane not found")
    }

    /// (`selectPane`, `layout-store.ts:526-540`.)
    pub fn select_pane(
        &self,
        tab_id: Option<&str>,
        pane_id: &str,
    ) -> Result<(String, String), &'static str> {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return Err("no layout snapshot");
        };
        let tab_exists = tab_id
            .map(|t| snapshot.tabs.iter().any(|tab| tab.id == t))
            .unwrap_or(false);
        let target = if tab_exists {
            tab_id.map(str::to_string)
        } else {
            find_pane_tab(snapshot, pane_id)
        };
        let Some(target) = target else {
            return Err("pane not found");
        };
        snapshot
            .active_pane
            .insert(target.clone(), pane_id.to_string());
        snapshot.active_tab_id = Some(target.clone());
        Ok((target, pane_id.to_string()))
    }

    /// Swaps content AND both title-map entries
    /// (`swapPane`, `layout-store.ts:609-654`).
    pub fn swap_pane(
        &self,
        tab_id: Option<&str>,
        pane_id: &str,
        other_id: &str,
    ) -> Result<String, &'static str> {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return Err("no layout snapshot");
        };
        let has_both = |snapshot: &UiSnapshot, tab: &str| {
            snapshot
                .layouts
                .get(tab)
                .map(|root| root.find_leaf(pane_id).is_some() && root.find_leaf(other_id).is_some())
                .unwrap_or(false)
        };
        let target = match tab_id.filter(|t| !t.is_empty()) {
            Some(t) => Some(t.to_string()),
            None => snapshot
                .tabs
                .iter()
                .map(|t| t.id.clone())
                .find(|t| has_both(snapshot, t)),
        };
        let Some(target) = target else {
            return Err("panes not found");
        };
        if !has_both(snapshot, &target) {
            return Err("panes not found");
        }
        let root = snapshot.layouts.get(&target).expect("checked above");
        let content_a = match root.find_leaf(pane_id) {
            Some(PaneNode::Leaf { content, .. }) => content.clone(),
            _ => return Err("panes not found"),
        };
        let content_b = match root.find_leaf(other_id) {
            Some(PaneNode::Leaf { content, .. }) => content.clone(),
            _ => return Err("panes not found"),
        };
        let root = snapshot.layouts.get_mut(&target).expect("checked above");
        root.replace_leaf_content(pane_id, content_b);
        root.replace_leaf_content(other_id, content_a);
        swap_map_entries(&mut snapshot.pane_titles, &target, pane_id, other_id);
        swap_map_entries(
            &mut snapshot.pane_title_set_by_user,
            &target,
            pane_id,
            other_id,
        );
        Ok(target)
    }

    /// splitId-first, then pane -> parent split; returns the split's CURRENT
    /// sizes (`resolveResizeTarget`, `router.ts:621-647` + `getSplitSizes`,
    /// `layout-store.ts:409-424`).
    pub fn resolve_resize_target(
        &self,
        raw: &str,
        tab_id: Option<&str>,
    ) -> Result<(String, String, [f64; 2]), &'static str> {
        {
            let inner = self.lock();
            if let Some(snapshot) = inner.snapshot.as_ref() {
                let candidates: Vec<String> = match tab_id {
                    Some(t) => vec![t.to_string()],
                    None => snapshot.tabs.iter().map(|t| t.id.clone()).collect(),
                };
                for candidate in candidates {
                    if let Some(PaneNode::Split { sizes, .. }) = snapshot
                        .layouts
                        .get(&candidate)
                        .and_then(|root| root.find_split(raw))
                    {
                        return Ok((candidate, raw.to_string(), *sizes));
                    }
                }
            }
            // Lock released before resolve_target re-enters the store.
        }
        match resolve_target(self, raw) {
            ResolvedTarget::Pane { pane_id, .. } => {
                let inner = self.lock();
                if let Some(snapshot) = inner.snapshot.as_ref() {
                    // `findSplitForPane` (`layout-store.ts:399-407`): all tabs.
                    for tab in &snapshot.tabs {
                        let Some(root) = snapshot.layouts.get(&tab.id) else {
                            continue;
                        };
                        if let Some(split_id) = root.find_parent_split_id(&pane_id) {
                            if let Some(PaneNode::Split { sizes, .. }) = root.find_split(&split_id)
                            {
                                return Ok((tab.id.clone(), split_id, *sizes));
                            }
                        }
                    }
                }
                Err("split not found")
            }
            ResolvedTarget::Ambiguous(message) => Err(message),
            ResolvedTarget::NotFound(_) => Err("split not found"),
        }
    }

    /// (`resizePane`'s recursive update, `layout-store.ts:656-678`, keyed to a
    /// known tab.)
    pub fn resize_split(&self, tab_id: &str, split_id: &str, sizes: [f64; 2]) -> bool {
        let mut inner = self.lock();
        let Some(snapshot) = inner.snapshot.as_mut() else {
            return false;
        };
        snapshot
            .layouts
            .get_mut(tab_id)
            .map(|root| root.set_split_sizes(split_id, sizes))
            .unwrap_or(false)
    }

    /// Root is a leaf (`getSinglePaneId`, `layout-store.ts:247-251`).
    pub fn get_single_pane_id(&self, tab_id: &str) -> Option<String> {
        let inner = self.lock();
        single_pane_id(inner.snapshot.as_ref()?, tab_id)
    }
}

// ── snapshot helpers ─────────────────────────────────────────────────────────

fn tab_row_value(tab: &TabRow) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), json!(tab.id));
    if let Some(title) = &tab.title {
        map.insert("title".to_string(), json!(title));
    }
    if let Some(fallback) = &tab.fallback_session_ref {
        map.insert("fallbackSessionRef".to_string(), fallback.clone());
    }
    Value::Object(map)
}

fn snapshot_value(snapshot: &UiSnapshot) -> Value {
    let mut out = Map::new();
    out.insert(
        "tabs".to_string(),
        Value::Array(snapshot.tabs.iter().map(tab_row_value).collect()),
    );
    out.insert(
        "activeTabId".to_string(),
        snapshot
            .active_tab_id
            .as_ref()
            .map(|id| json!(id))
            .unwrap_or(Value::Null),
    );
    out.insert(
        "layouts".to_string(),
        Value::Object(
            snapshot
                .layouts
                .iter()
                .map(|(k, v)| (k.clone(), v.to_value()))
                .collect(),
        ),
    );
    out.insert("activePane".to_string(), json!(snapshot.active_pane));
    out.insert("paneTitles".to_string(), json!(snapshot.pane_titles));
    out.insert(
        "paneTitleSetByUser".to_string(),
        json!(snapshot.pane_title_set_by_user),
    );
    if let Some(ts) = snapshot.timestamp {
        out.insert("timestamp".to_string(), json!(ts));
    }
    Value::Object(out)
}

fn nested_string_map(raw: Option<&Value>) -> HashMap<String, HashMap<String, String>> {
    let mut out = HashMap::new();
    let Some(obj) = raw.and_then(Value::as_object) else {
        return out;
    };
    for (tab_id, inner) in obj {
        let Some(inner) = inner.as_object() else {
            continue;
        };
        let map: HashMap<String, String> = inner
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect();
        out.insert(tab_id.clone(), map);
    }
    out
}

fn nested_bool_map(raw: Option<&Value>) -> HashMap<String, HashMap<String, bool>> {
    let mut out = HashMap::new();
    let Some(obj) = raw.and_then(Value::as_object) else {
        return out;
    };
    for (tab_id, inner) in obj {
        let Some(inner) = inner.as_object() else {
            continue;
        };
        let map: HashMap<String, bool> = inner
            .iter()
            .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
            .collect();
        out.insert(tab_id.clone(), map);
    }
    out
}

fn string_field(content: &Value, key: &str) -> Option<String> {
    content.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Depth-first `(paneId, content)` pairs for one tab's layout.
fn leaves_of(snapshot: &UiSnapshot, tab_id: &str) -> Vec<(String, Value)> {
    let Some(root) = snapshot.layouts.get(tab_id) else {
        return Vec::new();
    };
    let mut leaves = Vec::new();
    root.collect_leaves(&mut leaves);
    leaves
        .into_iter()
        .filter_map(|leaf| match leaf {
            PaneNode::Leaf { id, content } => Some((id.clone(), content.clone())),
            PaneNode::Split { .. } => None,
        })
        .collect()
}

fn find_pane_tab(snapshot: &UiSnapshot, pane_id: &str) -> Option<String> {
    snapshot
        .tabs
        .iter()
        .find(|tab| {
            snapshot
                .layouts
                .get(&tab.id)
                .and_then(|root| root.find_leaf(pane_id))
                .is_some()
        })
        .map(|tab| tab.id.clone())
}

fn single_pane_id(snapshot: &UiSnapshot, tab_id: &str) -> Option<String> {
    match snapshot.layouts.get(tab_id)? {
        PaneNode::Leaf { id, .. } => Some(id.clone()),
        PaneNode::Split { .. } => None,
    }
}

/// `seedPaneTitle` (`layout-store.ts:161-167`): derived titles never overwrite
/// a sticky (user-set) title; both per-tab maps are ensured like
/// `ensurePaneTitleMaps` (`:52-58`).
fn seed_pane_title(snapshot: &mut UiSnapshot, tab_id: &str, pane_id: &str, content: &Value) {
    let title = derive_pane_title(content);
    if title.is_empty() {
        return;
    }
    snapshot.pane_titles.entry(tab_id.to_string()).or_default();
    let set_by_user = snapshot
        .pane_title_set_by_user
        .entry(tab_id.to_string())
        .or_default();
    if set_by_user.get(pane_id).copied().unwrap_or(false) {
        return;
    }
    snapshot
        .pane_titles
        .get_mut(tab_id)
        .expect("ensured above")
        .insert(pane_id.to_string(), title);
}

fn set_sticky_title(snapshot: &mut UiSnapshot, tab_id: &str, pane_id: &str, title: &str) {
    snapshot
        .pane_titles
        .entry(tab_id.to_string())
        .or_default()
        .insert(pane_id.to_string(), title.to_string());
    snapshot
        .pane_title_set_by_user
        .entry(tab_id.to_string())
        .or_default()
        .insert(pane_id.to_string(), true);
}

/// `removePaneMetadata` (`layout-store.ts:71-85`): drop the pane's entries and
/// prune empty per-tab maps.
fn remove_pane_metadata(snapshot: &mut UiSnapshot, tab_id: &str, pane_id: &str) {
    if let Some(map) = snapshot.pane_titles.get_mut(tab_id) {
        map.remove(pane_id);
        if map.is_empty() {
            snapshot.pane_titles.remove(tab_id);
        }
    }
    if let Some(map) = snapshot.pane_title_set_by_user.get_mut(tab_id) {
        map.remove(pane_id);
        if map.is_empty() {
            snapshot.pane_title_set_by_user.remove(tab_id);
        }
    }
}

/// `swapPane`'s title-map exchange (`layout-store.ts:625-652`): the other
/// pane's missing entry DELETES yours.
fn swap_map_entries<V: Clone>(
    maps: &mut HashMap<String, HashMap<String, V>>,
    tab_id: &str,
    a: &str,
    b: &str,
) {
    let Some(map) = maps.get_mut(tab_id) else {
        return;
    };
    let value_a = map.get(a).cloned();
    let value_b = map.get(b).cloned();
    match value_b {
        Some(v) => {
            map.insert(a.to_string(), v);
        }
        None => {
            map.remove(a);
        }
    }
    match value_a {
        Some(v) => {
            map.insert(b.to_string(), v);
        }
        None => {
            map.remove(b);
        }
    }
}

#[cfg(test)]
#[path = "layout_store_tests.rs"]
mod tests;
