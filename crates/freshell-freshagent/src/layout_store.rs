//! Server-side UiSnapshot mirror (pure model).
//!
//! Port of `server/agent-api/layout-store.ts` — the layout snapshot the REST
//! automation surface reads and mutates. Pure model: no axum, no broadcasts;
//! Tasks 13-16 wire this into the REST routes and `ui.layout.sync` handling.
//!
//! INTENTIONAL DIVERGENCE from Node: this port keeps one snapshot PER client
//! connection instead of Node's single last-writer-wins snapshot, so pane/tab
//! ids from EVERY connected client resolve (see [`LayoutInner`]). Node retains
//! the single-snapshot behavior.
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

#[path = "layout_store_persist.rs"]
mod persist;
use persist::{load_persisted_clients, persist_locked};

mod publication;

/// One ORDERED tab row (`UiSnapshot.tabs`, `layout-store.ts:7`).
#[derive(Clone, Debug, Default)]
pub struct TabRow {
    pub id: String,
    pub title: Option<String>,
    /// Opaque `SessionLocator` carried through verbatim.
    pub fallback_session_ref: Option<Value>,
    /// Unified agent names (Task 2): which session names this tab — the
    /// source pane's canonical session name (`session` with the pane id),
    /// or the existing non-agent derivation (`legacy`). A tab stores the
    /// RELATIONSHIP, never a second name. `None` until initial content
    /// resolves ownership (an initial picker); derived deterministically
    /// from the snapshot's first leaf on every `update_from_ui` (the plan's
    /// "choose a deterministic original candidate once" — first-leaf
    /// scoped ⇒ that leaf; first-leaf non-agent ⇒ legacy), so a later
    /// agent added to a legacy tab never changes its naming.
    pub name_source: Option<freshell_protocol::session_names::TabNameSource>,
}

/// Unified agent names (Task 2/6): derive one tab's name source from its
/// layout — depth-first first-leaf order. A scoped agent leaf owns the tab
/// (`session` with that pane id); any other real content leaf is `legacy`;
/// a tab with no resolvable leaf — or whose FIRST leaf is still the initial
/// picker — keeps `None` (the unresolved initial-picker state: the picker's
/// first actual content choice resolves ownership, and a later mixed-tab
/// agent addition never claims it).
fn derive_name_source(
    snapshot: &UiSnapshot,
    tab_id: &str,
) -> Option<freshell_protocol::session_names::TabNameSource> {
    snapshot.layouts.get(tab_id)?;
    for (pane_id, content) in leaves_of(snapshot, tab_id) {
        let kind = content.get("kind").and_then(Value::as_str);
        let mode = content.get("mode").and_then(Value::as_str);
        let session_type = content.get("sessionType").and_then(Value::as_str);
        if crate::naming::is_unified_agent_mode(mode, session_type) {
            return Some(freshell_protocol::session_names::TabNameSource::Session { pane_id });
        }
        // A picker leaf is NOT an actual content choice: the tab stays
        // unresolved until the picker is replaced.
        if kind == Some("picker") {
            return None;
        }
        // Any other real content leaf (shell/browser/editor/terminal/
        // excluded providers): the existing non-agent derivation owns it.
        if kind.is_some() {
            return Some(freshell_protocol::session_names::TabNameSource::Legacy);
        }
    }
    None
}

/// Unified agent names (Task 6): the removal rule — the first remaining
/// SCOPED leaf in depth-first left-to-right order (optionally excluding the
/// pane the source lost), else the existing non-agent derivation.
fn next_name_source_after_source_loss(
    snapshot: &UiSnapshot,
    tab_id: &str,
    exclude_pane_id: Option<&str>,
) -> freshell_protocol::session_names::TabNameSource {
    for (pane_id, content) in leaves_of(snapshot, tab_id) {
        if Some(pane_id.as_str()) == exclude_pane_id {
            continue;
        }
        let mode = content.get("mode").and_then(Value::as_str);
        let session_type = content.get("sessionType").and_then(Value::as_str);
        if crate::naming::is_unified_agent_mode(mode, session_type) {
            return freshell_protocol::session_names::TabNameSource::Session { pane_id };
        }
    }
    freshell_protocol::session_names::TabNameSource::Legacy
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

/// One connected client's mirrored snapshot.
struct ClientEntry {
    key: String,
    snapshot: UiSnapshot,
    /// True once this client's WS connection closed (see [`LayoutStore::remove_client`]).
    /// Always false on a live sync.
    stale: bool,
}

/// Growth safety valve for stale-snapshot retention: at most this many stale
/// entries are kept; beyond it the OLDEST stale entry is dropped.
const MAX_STALE_ENTRIES: usize = 4;

/// Snapshot key for server-side bootstrap mutations (`create_tab` on an empty
/// store). Evicted on the first real client sync — mirroring the old
/// wholesale-replace semantics, where a client's `ui.layout.sync` superseded
/// server-created state.
const SERVER_CLIENT_KEY: &str = "__server__";

/// b8ke ext r25 F2: the per-recovery content-authority stamp — the
/// pane's PRE-recovery leaf content recorded at the authoritative
/// write-through (`attach_pane_content`). A reconnecting client's
/// stale copy re-sends exactly this content (it never saw the
/// recovery); `update_from_ui` rejects that pane write. ANY other
/// incoming content (the client observed the recovered state, or edited
/// past it) RELEASES the stamp — the client is authoritative again, so
/// a server recovery never permanently blocks legitimate edits.
#[derive(Clone, Debug, PartialEq)]
struct RecoveryStamp {
    pre_recovery_content: Value,
}

/// INTENTIONAL DIVERGENCE from Node (`server/agent-api/layout-store.ts` —
/// single-snapshot field `:49`, wholesale-replace `updateFromUi` `:169-181`):
/// Node keeps ONE shared snapshot, wholesale-replaced by whichever client
/// synced last (last-writer-wins). But pane/tab ids are client-local (`nanoid()` per
/// browser/device), so any client that was not the last writer got
/// `pane not found` from every by-id agent-API operation. This port keeps one
/// snapshot PER client connection instead:
///
/// - default/active-tab reads answer from the PRIMARY (most recently synced)
///   snapshot only — identical to Node with a single client connected;
/// - by-id lookups search the primary first, then the other clients
///   most-recent-first;
/// - mutations land in EVERY client snapshot containing the id (same-origin
///   windows share localStorage and therefore ids);
/// - a client's snapshot is marked STALE (retained, never primary while a
///   live client exists) when its WS connection closes — the client's layout
///   mirror is change-gated and never re-syncs on a silent reconnect, so
///   hard eviction would leave that client's ids unresolvable for an
///   unbounded window. A stale entry is dropped only when a live sync covers
///   every one of its pane ids (lossless supersede), or past the stale cap.
#[derive(Default)]
struct LayoutInner {
    /// Most-recent-sync-first. The PRIMARY is the most recently synced LIVE
    /// entry; if only stale entries remain, the most recent stale one
    /// (Node-parity post-disconnect reads).
    clients: Vec<ClientEntry>,
    /// b8ke ext r25 F2: the server-side CONTENT-AUTHORITY stamps for panes
    /// mutated through the authoritative recovery paths (the
    /// `attach_pane_content` write-throughs — the REST/MCP respawn and
    /// attach materializations). Keyed by pane id; each stamp records the
    /// pane's PRE-recovery leaf content — the exact stale copy a
    /// disconnected client still holds and may re-send on reconnect.
    /// In-memory only (a transient reconnect-reconciliation aid): the
    /// persist format serializes the client snapshots, not the stamps.
    recovery_stamps: std::collections::HashMap<String, RecoveryStamp>,
    /// Ordered server creations not yet observed in a browser layout sync.
    pending_publications: Vec<publication::PendingPublication>,
    /// kata b8ke Task 10 (round-1 review, DURABILITY): `Some` → every
    /// mutation that changes the snapshot set rewrites the multi-client
    /// snapshot to this path (atomic temp+rename) and construction loads
    /// it, so a server restart does not lose the pane registry.
    persist_path: Option<std::path::PathBuf>,
    /// kata b8ke Task 10 (round-2 review, M2): `Some` → every persist is
    /// SERIALIZED under the layout lock and HANDED to the ordered writer
    /// task (enqueued before the lock is released, so queue order ==
    /// mutation order); the writer performs each durable write inside
    /// `spawn_blocking` (the repo's A13 discipline), so the ~15ms fsync
    /// never pins an async worker and never runs under this mutex.
    /// `None` (tests, `None`-home runs) → the write runs inline on the
    /// mutating thread under the lock (the pre-M2 behavior; synchronous
    /// contexts only).
    persist_tx: Option<tokio::sync::mpsc::UnboundedSender<persist::PersistMsg>>,
}

impl LayoutInner {
    /// Index of the PRIMARY entry: the most recently synced LIVE entry, or —
    /// on a fully-stale store — the most recent stale one. `None` only when
    /// the store is truly empty.
    fn primary_index(&self) -> Option<usize> {
        if self.clients.is_empty() {
            return None;
        }
        Some(
            self.clients
                .iter()
                .position(|entry| !entry.stale)
                .unwrap_or(0),
        )
    }

    fn primary(&self) -> Option<&UiSnapshot> {
        self.primary_index().map(|i| &self.clients[i].snapshot)
    }

    fn primary_mut(&mut self) -> Option<&mut UiSnapshot> {
        let index = self.primary_index()?;
        Some(&mut self.clients[index].snapshot)
    }

    /// All client snapshots, primary first, then most-recent-first.
    fn snapshots(&self) -> impl Iterator<Item = &UiSnapshot> {
        self.clients.iter().map(|entry| &entry.snapshot)
    }

    fn snapshots_mut(&mut self) -> impl Iterator<Item = &mut UiSnapshot> {
        self.clients.iter_mut().map(|entry| &mut entry.snapshot)
    }

    /// `ensureSnapshot` (`layout-store.ts:212-217`) for server-side
    /// bootstraps: the primary snapshot, or a fresh server-owned one.
    fn ensure_primary(&mut self) -> &mut UiSnapshot {
        if self.clients.is_empty() {
            self.clients.push(ClientEntry {
                key: SERVER_CLIENT_KEY.to_string(),
                snapshot: UiSnapshot::default(),
                stale: false,
            });
        }
        let index = self.primary_index().expect("clients is non-empty");
        &mut self.clients[index].snapshot
    }
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

    /// kata b8ke Task 10 (round-1 review, DURABILITY): construct the store
    /// with a persistence path. Every mutation that changes the snapshot
    /// rewrites the multi-client snapshot to `path` with the atomic
    /// temp+rename discipline (the `~/.freshell/config.json` writer's
    /// pattern: write `path.tmp`, fsync, rename, parent-dir fsync), and
    /// construction LOADS a previously persisted file (best-effort: a
    /// corrupt/absent file logs a warning and boots empty — never a
    /// crash). Loaded entries are marked STALE: a restarted server has no
    /// live connections, and the client mirror is change-gated —
    /// retention is exactly what the stale-entry design exists for.
    ///
    /// Writes run INLINE on the mutating thread (fine for the synchronous
    /// test contexts that use this constructor); production — where
    /// mutators run on the async runtime — uses
    /// [`LayoutStore::with_persistence_offload`] instead, which hands
    /// every write to an ordered `spawn_blocking` writer (round-2 review
    /// M2).
    pub fn with_persistence(path: std::path::PathBuf) -> Self {
        let store = Self::default();
        {
            let mut inner = store.lock();
            inner.persist_path = Some(path.clone());
            match std::fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(body) => load_persisted_clients(&mut inner, &body),
                    Err(error) => tracing::warn!(
                        target: "freshell_freshagent::layout_store",
                        %error,
                        path = %path.display(),
                        "layout_store_persist_file_corrupt: booting empty"
                    ),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => tracing::warn!(
                    target: "freshell_freshagent::layout_store",
                    %error,
                    path = %path.display(),
                    "layout_store_persist_file_unreadable: booting empty"
                ),
            }
        }
        store
    }

    /// kata b8ke: paneId → owning tabId across per-client snapshots —
    /// primary-first, most-recent-first (the `resolve_pane_target`
    /// resolution order). REST-minted panes resolve via `pane_tabs` first;
    /// this covers browser-created/error panes that live only in layout
    /// syncs.
    pub fn find_pane_tab(&self, pane_id: &str) -> Option<String> {
        let inner = self.lock();
        for snapshot in inner.snapshots() {
            if let Some(tab_id) = find_pane_tab(snapshot, pane_id) {
                return Some(tab_id);
            }
        }
        None
    }

    /// Clones of every client snapshot — primary first, then most-recent-first
    /// — for read-only walkers (target resolver).
    pub(crate) fn snapshots_clone(&self) -> Vec<UiSnapshot> {
        self.lock()
            .clients
            .iter()
            .map(|entry| entry.snapshot.clone())
            .collect()
    }

    /// REPLACES this client's snapshot (multi-client store; see
    /// [`LayoutInner`]) and makes it the primary; runs the legacy fresh-agent
    /// migration on every layout node, then seeds a derived title per leaf
    /// (`updateFromUi`, `layout-store.ts:169-181`).
    pub fn update_from_ui(
        &self,
        sync: &freshell_protocol::UiLayoutSync,
        source_connection_id: &str,
    ) {
        // Unified agent names (Task 6): the replaced entry's per-tab
        // pointers, captured BEFORE the replacement so a sync that omits
        // the field (an old mirror) can never erase an initialized pointer.
        let previous_sources: HashMap<
            String,
            Option<freshell_protocol::session_names::TabNameSource>,
        > = self
            .lock()
            .clients
            .iter()
            .find(|entry| entry.key == source_connection_id)
            .map(|entry| {
                entry
                    .snapshot
                    .tabs
                    .iter()
                    .map(|t| (t.id.clone(), t.name_source.clone()))
                    .collect()
            })
            .unwrap_or_default();
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
                    // Unified agent names (Task 6): adopted from the client's
                    // synced pointer, carried over from this client's previous
                    // entry when the sync omits it, or derived (first-leaf
                    // rule) for genuinely new tabs — resolved after the
                    // layouts parse (the loop below).
                    name_source: tab
                        .name_source
                        .clone()
                        .or_else(|| previous_sources.get(&tab.id).cloned().flatten()),
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
        // Unified agent names (Task 6): resolve the still-UNSET pointers —
        // adopted/carried pointers stay authoritative; a tab new to this
        // client (no synced pointer, no previous pointer) derives
        // deterministically from its first leaf (see `derive_name_source` —
        // a legacy tab that later gains an agent pane keeps its legacy
        // naming; an initial picker stays unresolved).
        {
            let sources: Vec<(
                String,
                Option<freshell_protocol::session_names::TabNameSource>,
            )> = snapshot
                .tabs
                .iter()
                .map(|t| (t.id.clone(), derive_name_source(&snapshot, &t.id)))
                .collect();
            for (id, name_source) in sources {
                if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == id) {
                    if tab.name_source.is_none() {
                        tab.name_source = name_source;
                    }
                }
            }
        }
        for tab_id in tab_ids {
            for (pane_id, content) in leaves_of(&snapshot, &tab_id) {
                seed_pane_title(&mut snapshot, &tab_id, &pane_id, &content);
            }
        }
        let observed_pane_ids = pane_ids_of(&snapshot);
        let mut inner = self.lock();
        publication::preserve(&mut inner, &mut snapshot, &observed_pane_ids);
        let incoming_pane_ids = pane_ids_of(&snapshot);
        // b8ke ext r25 F2: THE SERVER RECOVERY'S CONTENT AUTHORITY. A
        // pane mutated through an authoritative recovery path (an
        // `attach_pane_content` write-through — the REST/MCP respawn and
        // attach materializations) carries a recovery stamp holding the
        // pane's PRE-recovery content. A reconnecting client's STALE
        // copy re-sends exactly that content (it never saw the recovery —
        // its pane never received the new sessionRef, so runtime-owner
        // replay cannot associate or repair an overwrite); that pane's
        // write is REJECTED: the incoming leaf is overridden with the
        // store's CURRENT (recovered) content — the server recovery wins,
        // and the reconnecting client receives/observes the server's
        // current layout state as usual (its next sync carries the
        // recovered content and converges).
        //
        // THE RELEASE POINT (per-recovery-write, never a permanent
        // block): ANY other incoming content releases the stamp — the
        // client either OBSERVED the server's recovered layout (its sync
        // now carries the recovered content) or EDITED past the
        // pre-recovery state — and the pane write applies; the client is
        // authoritative again. Panes without a stamp (ordinary client
        // layout edits) flow unchanged.
        if !inner.recovery_stamps.is_empty() {
            let mut stale_pane_writes: Vec<String> = Vec::new();
            let mut released_stamps: Vec<String> = Vec::new();
            for (pane_id, stamp) in inner.recovery_stamps.iter() {
                if !observed_pane_ids.contains(pane_id) {
                    continue;
                }
                let Some(incoming_content) = pane_content_in_snapshot(&snapshot, pane_id) else {
                    // The pane is not in this sync — the stamp stays (a
                    // later sync may still carry the stale copy).
                    continue;
                };
                if incoming_content == stamp.pre_recovery_content {
                    stale_pane_writes.push(pane_id.clone());
                } else {
                    released_stamps.push(pane_id.clone());
                }
            }
            for pane_id in stale_pane_writes {
                if let Some(current) = inner
                    .snapshots()
                    .find_map(|s| pane_content_in_snapshot(s, &pane_id))
                {
                    let tab_ids: Vec<String> = snapshot.tabs.iter().map(|t| t.id.clone()).collect();
                    for tab_id in &tab_ids {
                        let Some(root) = snapshot.layouts.get_mut(tab_id) else {
                            continue;
                        };
                        if root.replace_leaf_content(&pane_id, current.clone()) {
                            seed_pane_title(&mut snapshot, tab_id, &pane_id, &current);
                        }
                    }
                }
            }
            for pane_id in released_stamps {
                inner.recovery_stamps.remove(&pane_id);
            }
        }
        // Re-sync replaces this client's own snapshot; a real client sync also
        // supersedes the server bootstrap entry (old wholesale-replace parity).
        // SUBSET supersede-eviction: a STALE entry is dropped only when EVERY
        // pane id in it appears in the incoming live sync — lossless by
        // construction (every evicted id stays resolvable via the live entry),
        // so it needs no same-client inference. Mere id overlap is NOT enough:
        // server-minted agent-API ids are broadcast to EVERY client via
        // `ui.command{tab.create}`, so a one-id-overlap predicate would let
        // any live client's next sync discard a DIFFERENT disconnected
        // client's unique locally-minted ids during exactly the
        // silent-reconnect window retention protects.
        inner.clients.retain(|entry| {
            if entry.key == source_connection_id || entry.key == SERVER_CLIENT_KEY {
                return false;
            }
            !(entry.stale
                && pane_ids_of(&entry.snapshot)
                    .iter()
                    .all(|id| incoming_pane_ids.contains(id)))
        });
        inner.clients.insert(
            0,
            ClientEntry {
                key: source_connection_id.to_string(),
                snapshot,
                stale: false,
            },
        );
        persist_locked(&inner);
    }

    pub fn has_snapshot(&self) -> bool {
        !self.lock().clients.is_empty()
    }

    /// The PRIMARY (most recently synced live, else most recent stale)
    /// client's connection id.
    pub fn source_connection_id(&self) -> Option<String> {
        let inner = self.lock();
        let index = inner.primary_index()?;
        Some(inner.clients[index].key.clone()).filter(|key| key != SERVER_CLIENT_KEY)
    }

    /// Exact Node keys: `tabs`/`activeTabId`/`layouts`/`activePane`/`paneTitles`/
    /// `paneTitleSetByUser`/`timestamp`; the empty snapshot when none
    /// (`getNormalizedSnapshot`, `layout-store.ts:44-46, 191-210`).
    ///
    /// Multi-client store: the default (no tab id) read answers from the
    /// PRIMARY snapshot only; an EXPLICIT tab id resolves against the first
    /// client snapshot that knows it (primary first, then most-recent-first,
    /// same pattern as explicit-tab [`Self::list_panes`]), falling back to
    /// the primary (empty tab view) when none does.
    pub fn get_normalized_snapshot(&self, tab_id: Option<&str>) -> Value {
        let inner = self.lock();
        let Some(primary) = inner.primary() else {
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
            return snapshot_value(primary);
        };
        let snapshot = inner
            .snapshots()
            .find(|s| s.tabs.iter().any(|tab| tab.id == tab_id))
            .unwrap_or(primary);
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
        let Some(snapshot) = inner.primary() else {
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

    /// Matches by tab id OR title (`hasTab`, `layout-store.ts:336-339`),
    /// against ANY client snapshot (by-id/title resolution).
    pub fn has_tab(&self, target: &str) -> bool {
        let inner = self.lock();
        for snapshot in inner.snapshots() {
            if snapshot
                .tabs
                .iter()
                .any(|t| t.id == target || t.title.as_deref() == Some(target))
            {
                return true;
            }
        }
        false
    }

    /// `ensureSnapshot` + append an ordered tab with a single terminal leaf and
    /// a seeded title (`createTab`, `layout-store.ts:431-460`).
    pub fn create_tab(&self, title: Option<&str>) -> (String, String) {
        self.create_tab_with_publication(title, false)
    }

    pub(crate) fn create_pending_tab(&self, title: Option<&str>) -> (String, String) {
        self.create_tab_with_publication(title, true)
    }

    fn create_tab_with_publication(&self, title: Option<&str>, pending: bool) -> (String, String) {
        let tab_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();
        // `buildContent({})` (`layout-store.ts:317-325`): a detached terminal pane.
        let content = json!({ "kind": "terminal" });
        let mut inner = self.lock();
        let snapshot = inner.ensure_primary();
        snapshot.tabs.push(TabRow {
            id: tab_id.clone(),
            title: title.map(str::to_string),
            fallback_session_ref: None,
            // Unified agent names: derived from the just-created content
            // below.
            name_source: None,
        });
        snapshot.layouts.insert(
            tab_id.clone(),
            PaneNode::Leaf {
                id: pane_id.clone(),
                content: content.clone(),
            },
        );
        // Focus neutrality is a server contract: agent-created tabs stay in
        // the background so REST/MCP cursor-relative operations keep
        // addressing the USER's selection (mirrors the client's addTab fold
        // with `activate: false`, including its first-tab auto-activation).
        if snapshot.active_tab_id.is_none() {
            snapshot.active_tab_id = Some(tab_id.clone());
        }
        snapshot.active_pane.insert(tab_id.clone(), pane_id.clone());
        seed_pane_title(snapshot, &tab_id, &pane_id, &content);
        // Unified agent names (Task 2): the server-minted tab's name source
        // follows its original pane (a detached terminal leaf is legacy;
        // the fresh/attach paths re-derive after real content lands).
        let name_source = derive_name_source(snapshot, &tab_id);
        if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == tab_id) {
            tab.name_source = name_source;
        }
        if pending {
            inner
                .pending_publications
                .push(publication::PendingPublication {
                    tab_id: tab_id.clone(),
                    pane_id: pane_id.clone(),
                    placement: publication::Placement::Tab,
                    published: false,
                    create_request_id: None,
                });
        }
        persist_locked(&inner);
        (tab_id, pane_id)
    }

    /// Unified agent names (Task 2): read one tab's name source (the
    /// rename-tab route resolves THIS, never the active pane). Answers from
    /// the first client snapshot that knows the tab, mirroring the by-id
    /// lookup rule.
    pub fn tab_name_source(
        &self,
        tab_id: &str,
    ) -> Option<freshell_protocol::session_names::TabNameSource> {
        let inner = self.lock();
        let found = inner.snapshots().find_map(|snapshot| {
            snapshot
                .tabs
                .iter()
                .find(|t| t.id == tab_id)
                .and_then(|t| t.name_source.clone())
        });
        found
    }

    /// Unified agent names (Task 2/6): the source-pane remap after a pane
    /// close/move — when the closed pane WAS the tab's naming source, the
    /// tab follows the first remaining SCOPED leaf (depth-first
    /// left-to-right, never the first leaf of any kind), else falls back to
    /// legacy; a tab with no scoped leaf left returns to the existing
    /// non-agent derivation.
    pub fn remap_name_source_after_close(&self, tab_id: &str, closed_pane_id: &str) {
        let mut inner = self.lock();
        for snapshot in inner.snapshots_mut() {
            let matches_closed = snapshot
                .tabs
                .iter()
                .find(|t| t.id == tab_id)
                .and_then(|t| t.name_source.as_ref())
                .is_some_and(|source| {
                    matches!(
                        source,
                        freshell_protocol::session_names::TabNameSource::Session { pane_id }
                            if pane_id == closed_pane_id
                    )
                });
            if !matches_closed {
                continue;
            }
            let name_source = next_name_source_after_source_loss(snapshot, tab_id, None);
            if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == tab_id) {
                tab.name_source = Some(name_source);
            }
        }
    }

    /// Purges layouts/activePane/title maps (`closeTab`, `layout-store.ts:577-587`,
    /// plus `removeTabMetadata`, `:87-91`) in EVERY client snapshot containing
    /// the tab.
    pub fn close_tab(&self, tab_id: &str) -> RenameOutcome {
        let mut inner = self.lock();
        inner
            .pending_publications
            .retain(|entry| entry.tab_id != tab_id);
        if inner.clients.is_empty() {
            return RenameOutcome::failed("no layout snapshot");
        }
        let mut found = false;
        for snapshot in inner.snapshots_mut() {
            let Some(removed_index) = snapshot.tabs.iter().position(|t| t.id == tab_id) else {
                continue;
            };
            // Cursor parity with the client's removeTab reducer: a BACKGROUND
            // close never moves the selection (a failed agent create rolls the
            // layout back to exactly the user's tab); only closing the cursor's
            // own tab selects a survivor (previous neighbor, else the new first).
            let was_active = snapshot.active_tab_id.as_deref() == Some(tab_id);
            snapshot.tabs.remove(removed_index);
            snapshot.layouts.remove(tab_id);
            snapshot.active_pane.remove(tab_id);
            snapshot.pane_titles.remove(tab_id);
            snapshot.pane_title_set_by_user.remove(tab_id);
            if was_active {
                let next_index = if removed_index > 0 {
                    removed_index - 1
                } else {
                    0
                };
                snapshot.active_tab_id = snapshot
                    .tabs
                    .get(next_index)
                    .or_else(|| snapshot.tabs.first())
                    .map(|t| t.id.clone());
            }
            found = true;
        }
        if found {
            persist_locked(&inner);
            RenameOutcome::tab(tab_id)
        } else {
            RenameOutcome::failed("tab not found")
        }
    }

    /// Sets the active tab in every client snapshot that has it
    /// (`selectTab`, `layout-store.ts:518-524`).
    pub fn select_tab(&self, tab_id: &str) -> RenameOutcome {
        let mut inner = self.lock();
        let mut found = false;
        for snapshot in inner.snapshots_mut() {
            if snapshot.tabs.iter().any(|t| t.id == tab_id) {
                snapshot.active_tab_id = Some(tab_id.to_string());
                found = true;
            }
        }
        if found {
            persist_locked(&inner);
            RenameOutcome::tab(tab_id)
        } else {
            RenameOutcome::failed("tab not found")
        }
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
        let snapshot = inner.primary_mut()?;
        if snapshot.tabs.is_empty() {
            return None;
        }
        let current = snapshot
            .tabs
            .iter()
            .position(|t| Some(&t.id) == snapshot.active_tab_id.as_ref());
        let tab_id = snapshot.tabs[pick(current, snapshot.tabs.len())].id.clone();
        snapshot.active_tab_id = Some(tab_id.clone());
        persist_locked(&inner);
        Some(tab_id)
    }

    /// Sets the tab title; single-pane tabs mirror it into the pane title maps
    /// as sticky (`renameTab`, `layout-store.ts:542-556`). Lands in EVERY
    /// client snapshot containing the tab.
    pub fn rename_tab(&self, tab_id: &str, title: &str) -> RenameOutcome {
        let mut inner = self.lock();
        if inner.clients.is_empty() {
            return RenameOutcome::failed("no layout snapshot");
        }
        let mut found = false;
        for snapshot in inner.snapshots_mut() {
            let Some(index) = snapshot.tabs.iter().position(|t| t.id == tab_id) else {
                continue;
            };
            snapshot.tabs[index].title = Some(title.to_string());
            // Node guard is `if (singlePaneId && title)` — empty titles don't mirror.
            if !title.is_empty() {
                if let Some(pane_id) = single_pane_id(snapshot, tab_id) {
                    set_sticky_title(snapshot, tab_id, &pane_id, title);
                }
            }
            found = true;
        }
        if found {
            persist_locked(&inner);
            RenameOutcome::tab(tab_id)
        } else {
            RenameOutcome::failed("tab not found")
        }
    }

    /// Sets the pane title sticky; single-pane tabs mirror it onto the tab
    /// title (`renamePane`, `layout-store.ts:558-575`). Lands in EVERY client
    /// snapshot containing the pane (two same-origin windows share
    /// localStorage and therefore pane ids); the reported `tabId` comes from
    /// the first (most-recent) match.
    pub fn rename_pane(&self, pane_id: &str, title: &str) -> RenameOutcome {
        let mut inner = self.lock();
        if inner.clients.is_empty() {
            return RenameOutcome::failed("no layout snapshot");
        }
        let mut first: Option<String> = None;
        for snapshot in inner.snapshots_mut() {
            let Some(tab_id) = find_pane_tab(snapshot, pane_id) else {
                continue;
            };
            set_sticky_title(snapshot, &tab_id, pane_id, title);
            if single_pane_id(snapshot, &tab_id).as_deref() == Some(pane_id) {
                if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == tab_id) {
                    tab.title = Some(title.to_string());
                }
            }
            first.get_or_insert(tab_id);
        }
        if first.is_some() {
            persist_locked(&inner);
        }
        match first {
            Some(tab_id) => RenameOutcome::tab_pane(&tab_id, pane_id),
            None => RenameOutcome::failed("pane not found"),
        }
    }

    /// Default tab = active then first, answered from the PRIMARY snapshot
    /// (`listPanes`, `layout-store.ts:341-355`); an EXPLICIT tab id resolves
    /// against the first client snapshot that knows it (multi-client store),
    /// falling back to the primary (empty rows) when none does.
    pub fn list_panes(&self, tab_id: Option<&str>) -> Result<Vec<PaneRow>, &'static str> {
        let inner = self.lock();
        let Some(primary) = inner.primary() else {
            return Err("no layout snapshot");
        };
        let (snapshot, resolved) = match tab_id.filter(|t| !t.is_empty()) {
            Some(target) => (
                inner
                    .snapshots()
                    .find(|s| s.tabs.iter().any(|tab| tab.id == target))
                    .unwrap_or(primary),
                target.to_string(),
            ),
            None => {
                let resolved = primary
                    .active_tab_id
                    .clone()
                    .filter(|t| !t.is_empty())
                    .or_else(|| primary.tabs.first().map(|t| t.id.clone()));
                let Some(resolved) = resolved else {
                    return Ok(Vec::new());
                };
                (primary, resolved)
            }
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

    /// (`getPaneSnapshot`, `layout-store.ts:379-397`.) Resolves against the
    /// first client snapshot (primary first, then most-recent-first) that
    /// contains the pane.
    pub fn get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot> {
        let inner = self.lock();
        for snapshot in inner.snapshots() {
            let Some(tab_id) = find_pane_tab(snapshot, pane_id) else {
                continue;
            };
            let Some(leaf) = snapshot
                .layouts
                .get(&tab_id)
                .and_then(|root| root.find_leaf(pane_id))
            else {
                continue;
            };
            let content = match leaf {
                PaneNode::Leaf { content, .. } => content.clone(),
                PaneNode::Split { .. } => continue,
            };
            return Some(PaneSnapshot {
                tab_id,
                pane_id: pane_id.to_string(),
                kind: string_field(&content, "kind"),
                terminal_id: string_field(&content, "terminalId"),
                pane_content: (!content.is_null()).then_some(content),
            });
        }
        None
    }

    /// Binary split 50/50; the new pane is seeded with a title but does NOT
    /// become active (`splitPane`, `layout-store.ts:462-499` — the cursor
    /// stays on the user's pane; focus moves only via explicit selects).
    /// Applied (with the SAME new ids) to every client snapshot containing
    /// the source pane; the reported tab comes from the first (most-recent)
    /// match.
    pub fn split_pane(
        &self,
        pane_id: &str,
        direction: &str,
    ) -> Result<(String, String), &'static str> {
        self.split_pane_with_publication(pane_id, direction, false)
    }

    pub(crate) fn split_pending_pane(
        &self,
        pane_id: &str,
        direction: &str,
    ) -> Result<(String, String), &'static str> {
        self.split_pane_with_publication(pane_id, direction, true)
    }

    fn split_pane_with_publication(
        &self,
        pane_id: &str,
        direction: &str,
        pending: bool,
    ) -> Result<(String, String), &'static str> {
        let mut inner = self.lock();
        let new_pane_id = Uuid::new_v4().to_string();
        let split_node_id = Uuid::new_v4().to_string();
        let new_content = json!({ "kind": "terminal" });
        let mut first: Option<String> = None;
        for snapshot in inner.snapshots_mut() {
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
                let split = PaneNode::Split {
                    id: split_node_id.clone(),
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
                    // Agent splits are focus-neutral even on the server cursor:
                    // keep the pre-split active pane (the client's splitPane
                    // fold carries activate:false).
                    seed_pane_title(snapshot, &tab_id, &new_pane_id, &new_content);
                    first.get_or_insert(tab_id);
                    break;
                }
            }
        }
        match first {
            Some(tab_id) => {
                if pending {
                    inner
                        .pending_publications
                        .push(publication::PendingPublication {
                            tab_id: tab_id.clone(),
                            pane_id: new_pane_id.clone(),
                            placement: publication::Placement::Split {
                                source_pane_id: pane_id.to_string(),
                                split_node_id,
                                direction: direction.to_string(),
                            },
                            published: false,
                            create_request_id: None,
                        });
                }
                persist_locked(&inner);
                Ok((tab_id, new_pane_id))
            }
            None => Err("pane not found"),
        }
    }

    /// Remove an unannounced split leaf after its runtime failed to launch.
    /// Preserve the surrounding split IDs, direction, sizes and any content
    /// updates that arrived while creation awaited the provider.
    pub(crate) fn rollback_split(&self, pane_id: &str) -> bool {
        let mut inner = self.lock();
        inner
            .pending_publications
            .retain(|entry| entry.pane_id != pane_id);
        let mut removed = false;
        for snapshot in inner.snapshots_mut() {
            let tab_id = snapshot.layouts.iter_mut().find_map(|(tab_id, root)| {
                collapse_split_leaf(root, pane_id).then(|| tab_id.clone())
            });
            if let Some(tab_id) = tab_id {
                remove_pane_metadata(snapshot, &tab_id, pane_id);
                removed = true;
            }
        }
        if removed {
            inner.recovery_stamps.remove(pane_id);
            persist_locked(&inner);
        }
        removed
    }

    /// A settled send can change its live conversation (/clear). Update only
    /// the pane that still names the accepted conversation; a concurrent
    /// replacement owns its newer content. The same lock guards that check
    /// and the write, and the recovery stamp protects an old client mirror.
    pub(crate) fn rekey_agent_pane_if_current(
        &self,
        pane_id: &str,
        provider: &str,
        session_type: &str,
        before: &str,
        after: &str,
    ) -> bool {
        let matches = |content: &Value| {
            let identity = content
                .get("sessionRef")
                .filter(|reference| reference["provider"].as_str() == Some(provider))
                .and_then(|reference| reference["sessionId"].as_str())
                .filter(|id| !id.is_empty())
                .or_else(|| content["sessionId"].as_str());
            content["kind"] == "fresh-agent"
                && content["provider"].as_str() == Some(provider)
                && content["sessionType"].as_str() == Some(session_type)
                && identity == Some(before)
        };
        let mut inner = self.lock();
        let Some(pre_recovery) = inner
            .snapshots()
            .find_map(|snapshot| pane_content_in_snapshot(snapshot, pane_id))
        else {
            return false;
        };
        if !matches(&pre_recovery) {
            return false;
        }
        for snapshot in inner.snapshots_mut() {
            for root in snapshot.layouts.values_mut() {
                let Some(PaneNode::Leaf { content, .. }) = root.find_leaf(pane_id) else {
                    continue;
                };
                if !matches(content) {
                    continue;
                }
                let mut current = content.clone();
                current["sessionId"] = json!(after);
                current["sessionRef"] = json!({ "provider":provider, "sessionId":after });
                root.replace_leaf_content(pane_id, current);
                break;
            }
        }
        inner.recovery_stamps.insert(
            pane_id.to_string(),
            RecoveryStamp {
                pre_recovery_content: pre_recovery,
            },
        );
        persist_locked(&inner);
        true
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
        if inner.clients.is_empty() {
            return RenameOutcome::failed("no layout snapshot");
        }
        let normalized = migrate_legacy_fresh_agent_content(&content);
        // b8ke ext r25 F2: capture the pane's PRE-recovery content (the
        // first snapshot holding the pane, primary-first) for the
        // content-authority stamp — a reconnecting client's stale copy of
        // this pane re-sends exactly this content and must not erase the
        // recovery.
        let pre_recovery = inner
            .snapshots()
            .find_map(|snapshot| pane_content_in_snapshot(snapshot, pane_id));
        let mut found = false;
        for snapshot in inner.snapshots_mut() {
            let Some(root) = snapshot.layouts.get_mut(tab_id) else {
                continue;
            };
            // Node's recursive update is a no-op for an absent pane but still
            // reports `{tabId, paneId}` — mirrored here (return value ignored).
            root.replace_leaf_content(pane_id, normalized.clone());
            seed_pane_title(snapshot, tab_id, pane_id, &normalized);
            // Unified agent names (Task 2/6): the content attach is the
            // initial-content-choice moment ONLY for an unresolved tab (a
            // picker resolving to its first scoped content). A resolved
            // pointer never re-derives — a legacy tab attaching an agent
            // keeps its naming, and a session-owned tab whose SOURCE pane's
            // content became non-agent follows the removal rule.
            let current_source = snapshot
                .tabs
                .iter()
                .find(|t| t.id == tab_id)
                .and_then(|t| t.name_source.clone());
            let next_source = match current_source {
                None => derive_name_source(snapshot, tab_id),
                Some(freshell_protocol::session_names::TabNameSource::Session {
                    pane_id: source_pane_id,
                }) if source_pane_id == pane_id => {
                    let still_scoped = {
                        let mode = normalized.get("mode").and_then(Value::as_str);
                        let session_type = normalized.get("sessionType").and_then(Value::as_str);
                        crate::naming::is_unified_agent_mode(mode, session_type)
                    };
                    if still_scoped {
                        Some(freshell_protocol::session_names::TabNameSource::Session {
                            pane_id: source_pane_id,
                        })
                    } else {
                        Some(next_name_source_after_source_loss(
                            snapshot,
                            tab_id,
                            Some(&source_pane_id),
                        ))
                    }
                }
                other => other,
            };
            if let Some(tab) = snapshot.tabs.iter_mut().find(|t| t.id == tab_id) {
                tab.name_source = next_source;
            }
            found = true;
        }
        if found {
            if let Some(pending) = inner
                .pending_publications
                .iter_mut()
                .find(|entry| entry.pane_id == pane_id)
            {
                pending.published = true;
                pending.create_request_id = normalized
                    .get("createRequestId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            // b8ke ext r25 F2: record the recovery stamp ONLY when the
            // write actually changed the pane's content — an idempotent
            // re-attach (the same content) stamps nothing.
            if pre_recovery.as_ref().is_some_and(|pre| *pre != normalized) {
                inner.recovery_stamps.insert(
                    pane_id.to_string(),
                    RecoveryStamp {
                        pre_recovery_content: pre_recovery.expect("checked above"),
                    },
                );
            }
            persist_locked(&inner);
            RenameOutcome::tab_pane(tab_id, pane_id)
        } else {
            RenameOutcome::failed("tab not found")
        }
    }

    /// Pure tree mutation — never kills PTYs (`closePane`, `layout-store.ts:501-516`).
    /// Applied to every client snapshot containing the pane; the FIRST
    /// (most-recent) match is authoritative for the returned result, and an
    /// error there leaves every other snapshot untouched.
    pub fn close_pane(&self, pane_id: &str) -> Result<String, &'static str> {
        // Unified agent names (Task 2): the close's return value names the
        // tab; the source remap below needs it, so capture the outcome first.
        let closed_tab = Self::close_pane_inner(self, pane_id)?;
        self.remap_name_source_after_close(&closed_tab, pane_id);
        Ok(closed_tab)
    }

    /// The pre-existing `close_pane` body (the removal rule's actual
    /// layout surgery), unchanged.
    fn close_pane_inner(&self, pane_id: &str) -> Result<String, &'static str> {
        let mut inner = self.lock();
        if inner.clients.is_empty() {
            return Err("no layout snapshot");
        }
        let mut first: Option<Result<String, &'static str>> = None;
        for snapshot in inner.snapshots_mut() {
            let Some(result) = close_pane_in(snapshot, pane_id) else {
                continue;
            };
            let refused = result.is_err();
            if first.is_none() {
                first = Some(result);
                if refused {
                    break;
                }
            }
        }
        if first.as_ref().is_some_and(|result| result.is_ok()) {
            // b8ke ext r25 F2: a closed pane's recovery stamp is dead
            // weight — the pane no longer exists to protect.
            inner.recovery_stamps.remove(pane_id);
            inner
                .pending_publications
                .retain(|entry| entry.pane_id != pane_id);
            persist_locked(&inner);
        }
        first.unwrap_or(Err("pane not found"))
    }

    /// (`selectPane`, `layout-store.ts:526-540`.) Applied to every client
    /// snapshot where the target resolves; the reported tab comes from the
    /// first (most-recent) match.
    pub fn select_pane(
        &self,
        tab_id: Option<&str>,
        pane_id: &str,
    ) -> Result<(String, String), &'static str> {
        let mut inner = self.lock();
        if inner.clients.is_empty() {
            return Err("no layout snapshot");
        }
        let mut first: Option<String> = None;
        for snapshot in inner.snapshots_mut() {
            let tab_exists = tab_id
                .map(|t| snapshot.tabs.iter().any(|tab| tab.id == t))
                .unwrap_or(false);
            let target = if tab_exists {
                tab_id.map(str::to_string)
            } else {
                find_pane_tab(snapshot, pane_id)
            };
            let Some(target) = target else {
                continue;
            };
            snapshot
                .active_pane
                .insert(target.clone(), pane_id.to_string());
            snapshot.active_tab_id = Some(target.clone());
            first.get_or_insert(target);
        }
        if first.is_some() {
            persist_locked(&inner);
        }
        match first {
            Some(target) => Ok((target, pane_id.to_string())),
            None => Err("pane not found"),
        }
    }

    /// Swaps content AND both title-map entries
    /// (`swapPane`, `layout-store.ts:609-654`). Applied to every client
    /// snapshot holding BOTH panes in one tab; the reported tab comes from
    /// the first (most-recent) match.
    pub fn swap_pane(
        &self,
        tab_id: Option<&str>,
        pane_id: &str,
        other_id: &str,
    ) -> Result<String, &'static str> {
        let mut inner = self.lock();
        if inner.clients.is_empty() {
            return Err("no layout snapshot");
        }
        let has_both = |snapshot: &UiSnapshot, tab: &str| {
            snapshot
                .layouts
                .get(tab)
                .map(|root| root.find_leaf(pane_id).is_some() && root.find_leaf(other_id).is_some())
                .unwrap_or(false)
        };
        let mut first: Option<String> = None;
        for snapshot in inner.snapshots_mut() {
            let target = match tab_id.filter(|t| !t.is_empty()) {
                Some(t) => Some(t.to_string()),
                None => snapshot
                    .tabs
                    .iter()
                    .map(|t| t.id.clone())
                    .find(|t| has_both(snapshot, t)),
            };
            let Some(target) = target else {
                continue;
            };
            if !has_both(snapshot, &target) {
                continue;
            }
            let root = snapshot.layouts.get(&target).expect("checked above");
            let content_a = match root.find_leaf(pane_id) {
                Some(PaneNode::Leaf { content, .. }) => content.clone(),
                _ => continue,
            };
            let content_b = match root.find_leaf(other_id) {
                Some(PaneNode::Leaf { content, .. }) => content.clone(),
                _ => continue,
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
            first.get_or_insert(target);
        }
        if first.is_some() {
            persist_locked(&inner);
        }
        first.ok_or("panes not found")
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
            for snapshot in inner.snapshots() {
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
                // `findSplitForPane` (`layout-store.ts:399-407`): all tabs,
                // across every client snapshot (primary first).
                for snapshot in inner.snapshots() {
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
        let mut any = false;
        for snapshot in inner.snapshots_mut() {
            if let Some(root) = snapshot.layouts.get_mut(tab_id) {
                any |= root.set_split_sizes(split_id, sizes);
            }
        }
        if any {
            persist_locked(&inner);
        }
        any
    }

    /// Root is a leaf (`getSinglePaneId`, `layout-store.ts:247-251`),
    /// answered by the first client snapshot that knows the tab.
    pub fn get_single_pane_id(&self, tab_id: &str) -> Option<String> {
        let inner = self.lock();
        for snapshot in inner.snapshots() {
            if snapshot.layouts.contains_key(tab_id) {
                return single_pane_id(snapshot, tab_id);
            }
        }
        None
    }

    /// Marks the snapshot owned by `client_key` STALE (WS disconnect) instead
    /// of dropping it: the client's layout mirror (`layoutMirrorMiddleware.ts`)
    /// is change-gated and never re-sends on a silent reconnect, so hard
    /// eviction would leave that client's ids unresolvable until its next
    /// layout change. The primary falls back to the most recently synced LIVE
    /// client; by-id reads and mutations keep treating the stale entry like a
    /// live one. The entry is dropped when a later live sync covers every one
    /// of its pane ids ([`Self::update_from_ui`]'s subset supersede) or when
    /// it falls past the stale cap ([`MAX_STALE_ENTRIES`], oldest first).
    pub fn remove_client(&self, client_key: &str) {
        let mut inner = self.lock();
        if let Some(entry) = inner
            .clients
            .iter_mut()
            .find(|entry| entry.key == client_key)
        {
            entry.stale = true;
        }
        // Growth safety valve: the vec is most-recent-first, so the LAST
        // stale entry is the oldest.
        while inner.clients.iter().filter(|e| e.stale).count() > MAX_STALE_ENTRIES {
            let oldest = inner
                .clients
                .iter()
                .rposition(|e| e.stale)
                .expect("count above cap implies a stale entry exists");
            inner.clients.remove(oldest);
        }
        // The stale-flag flip and the prune both change the snapshot set —
        // persist unconditionally (a no-change mark is a cheap no-op write).
        persist_locked(&inner);
    }

    /// Total retained entries (live + stale) — test/diagnostic probe.
    pub fn client_entry_count(&self) -> usize {
        self.lock().clients.len()
    }

    /// Retained STALE (disconnected) entries — test/diagnostic probe; the WS
    /// integration test uses this as its disconnect-processed and
    /// supersede-processed barriers.
    pub fn stale_entry_count(&self) -> usize {
        self.lock().clients.iter().filter(|e| e.stale).count()
    }

    /// Whether the tab holding `pane_id` has exactly one pane — the
    /// `tabRenamed` check of `PATCH /api/panes/:id` (`router.ts:1414-1415`),
    /// answered from the snapshot where the pane actually resolves (NOT the
    /// primary's same-id tab, which may have a different shape).
    pub fn pane_is_sole_in_tab(&self, pane_id: &str) -> bool {
        let inner = self.lock();
        for snapshot in inner.snapshots() {
            if let Some(tab_id) = find_pane_tab(snapshot, pane_id) {
                return leaves_of(snapshot, &tab_id).len() == 1;
            }
        }
        false
    }
}

// ── snapshot helpers ─────────────────────────────────────────────────────────

// The durable-persistence half (persist_locked/load + the M2 ordered
// writer) lives in [`persist`] (`layout_store_persist.rs`).

impl LayoutStore {
    /// kata b8ke Task 10 (round-2 review, M2): the PRODUCTION construction
    /// — [`LayoutStore::with_persistence`] plus the ordered offload writer
    /// on `runtime`. Every snapshot-set mutation serializes its snapshot
    /// under the layout lock, hands it to the writer, and returns without
    /// blocking; the writer performs each durable write (atomic
    /// temp+rename+parent-fsync) inside `spawn_blocking` — the repo's A13
    /// discipline (`terminal.rs` / pane-ledger writes) — strictly in
    /// mutation order. [`Self::flush_persistence`] drains the queue
    /// (graceful shutdown; tests).
    pub fn with_persistence_offload(
        path: std::path::PathBuf,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        let store = Self::with_persistence(path);
        let tx = persist::spawn_offload_writer(&runtime);
        store.lock().persist_tx = Some(tx);
        store
    }

    /// Wait until every persist queued before this call has landed on disk
    /// (graceful shutdown; tests). No-op without the offload writer — the
    /// inline path is synchronous by construction.
    pub async fn flush_persistence(&self) {
        let tx = self.lock().persist_tx.clone();
        if let Some(tx) = tx {
            persist::send_flush_and_wait(&tx).await;
        }
    }
}

fn tab_row_value(tab: &TabRow) -> Value {
    let mut map = Map::new();
    map.insert("id".to_string(), json!(tab.id));
    if let Some(title) = &tab.title {
        map.insert("title".to_string(), json!(title));
    }
    if let Some(fallback) = &tab.fallback_session_ref {
        map.insert("fallbackSessionRef".to_string(), fallback.clone());
    }
    // Unified agent names (Task 6): the stable naming-source relationship
    // round-trips the REST/agent-API snapshot read (rename-tab routes resolve
    // THIS, never the active pane). Omitted when unresolved, matching the
    // additive wire shape.
    if let Some(name_source) = &tab.name_source {
        if let Ok(value) = serde_json::to_value(name_source) {
            map.insert("nameSource".to_string(), value);
        }
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

/// Every pane id in every tab layout of one snapshot — the supersede
/// (subset) check's unit of coverage.
fn pane_ids_of(snapshot: &UiSnapshot) -> std::collections::HashSet<String> {
    snapshot
        .layouts
        .keys()
        .flat_map(|tab_id| leaves_of(snapshot, tab_id))
        .map(|(id, _content)| id)
        .collect()
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

/// b8ke ext r25 F2: the pane's leaf content within one snapshot (the
/// first tab layout holding it) — the content-authority stamp's capture
/// and the reconnecting-stale-copy comparison.
fn pane_content_in_snapshot(snapshot: &UiSnapshot, pane_id: &str) -> Option<Value> {
    snapshot
        .layouts
        .values()
        .find_map(|root| match root.find_leaf(pane_id) {
            Some(PaneNode::Leaf { content, .. }) => Some(content.clone()),
            _ => None,
        })
}

/// `closePane` (`layout-store.ts:501-516`) against ONE snapshot: `None` when
/// no tab of this snapshot contains the pane; mutates only on `Ok`.
fn close_pane_in(snapshot: &mut UiSnapshot, pane_id: &str) -> Option<Result<String, &'static str>> {
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
            return Some(Err("cannot close only pane"));
        }
        let last_id = match remaining.last() {
            Some(PaneNode::Leaf { id, .. }) => id.clone(),
            _ => return Some(Err("pane not found")),
        };
        let rebuilt = build_grid_layout(remaining);
        snapshot.layouts.insert(tab_id.clone(), rebuilt);
        snapshot.active_pane.insert(tab_id.clone(), last_id);
        remove_pane_metadata(snapshot, &tab_id, pane_id);
        return Some(Ok(tab_id));
    }
    None
}

fn collapse_split_leaf(root: &mut PaneNode, pane_id: &str) -> bool {
    let PaneNode::Split { children, .. } = root else {
        return false;
    };
    for removed in 0..2 {
        if matches!(&children[removed], PaneNode::Leaf { id, .. } if id == pane_id) {
            *root = children[1 - removed].clone();
            return true;
        }
    }
    collapse_split_leaf(&mut children[0], pane_id) || collapse_split_leaf(&mut children[1], pane_id)
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
