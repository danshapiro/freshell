//! Tests for [`crate::layout_store`] (split out per this branch's precedent to
//! keep `layout_store.rs` under the 1,000-line ceiling).

use super::*;
use freshell_protocol::UiLayoutSync;
use serde_json::{json, Value};

fn sync_from(v: Value) -> UiLayoutSync {
    serde_json::from_value(v).expect("UiLayoutSync parses")
}

fn leaf(id: &str, content: Value) -> Value {
    json!({ "type": "leaf", "id": id, "content": content })
}

fn split(id: &str, direction: &str, sizes: [i64; 2], a: Value, b: Value) -> Value {
    json!({
        "type": "split",
        "id": id,
        "direction": direction,
        "sizes": sizes,
        "children": [a, b],
    })
}

/// One tab `t1`, single claude-terminal leaf `p1`.
fn single_pane_sync(
    pane_titles: Option<Value>,
    set_by_user: Option<Value>,
    timestamp: i64,
) -> UiLayoutSync {
    let mut payload = json!({
        "tabs": [{ "id": "t1", "title": "First" }],
        "activeTabId": "t1",
        "layouts": { "t1": leaf("p1", json!({ "kind": "terminal", "mode": "claude" })) },
        "activePane": { "t1": "p1" },
        "timestamp": timestamp,
    });
    if let Some(titles) = pane_titles {
        payload["paneTitles"] = titles;
    }
    if let Some(flags) = set_by_user {
        payload["paneTitleSetByUser"] = flags;
    }
    sync_from(payload)
}

#[test]
fn update_from_ui_replaces_snapshot_and_seeds_nonsticky_titles() {
    let store = LayoutStore::default();
    store.update_from_ui(&single_pane_sync(None, None, 1000), "conn-1");

    assert!(store.has_snapshot());
    assert_eq!(store.source_connection_id().as_deref(), Some("conn-1"));

    // No paneTitles in the sync -> derived title seeded, non-sticky
    // (layout-store.ts:161-181).
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["t1"]["p1"], json!("Claude CLI"));
    assert!(
        snap["paneTitleSetByUser"]["t1"].get("p1").is_none(),
        "set_by_user stays false"
    );
    assert_eq!(snap["timestamp"], json!(1000));
    assert_eq!(snap["activeTabId"], json!("t1"));

    // Second sync with a sticky user title -> preserved (seed skips sticky panes).
    let sync2 = single_pane_sync(
        Some(json!({ "t1": { "p1": "My Pane" } })),
        Some(json!({ "t1": { "p1": true } })),
        2000,
    );
    store.update_from_ui(&sync2, "conn-2");
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["t1"]["p1"], json!("My Pane"));
    assert_eq!(snap["paneTitleSetByUser"]["t1"]["p1"], json!(true));
    assert_eq!(
        snap["timestamp"],
        json!(2000),
        "snapshot REPLACED, not merged"
    );
    assert_eq!(store.source_connection_id().as_deref(), Some("conn-2"));

    // Tab-filtered normalized snapshot (layout-store.ts:196-209).
    let filtered = store.get_normalized_snapshot(Some("t1"));
    assert_eq!(filtered["tabs"].as_array().map(Vec::len), Some(1));
    assert_eq!(filtered["activeTabId"], json!("t1"));
    let missing = store.get_normalized_snapshot(Some("zzz"));
    assert_eq!(missing["tabs"], json!([]));
    assert_eq!(missing["activeTabId"], Value::Null);
}

#[test]
fn rename_pane_mirrors_to_tab_when_single_pane_and_reports_tab_renamed() {
    let store = LayoutStore::default();
    store.update_from_ui(&single_pane_sync(None, None, 1), "c");

    let out = store.rename_pane("p1", "Renamed");
    assert_eq!(
        out.tab_id.as_deref(),
        Some("t1"),
        "RenameOutcome carries tab_id"
    );
    assert_eq!(out.pane_id.as_deref(), Some("p1"));
    assert_eq!(out.message, None);

    let (rows, _) = store.list_tabs();
    assert_eq!(
        rows[0]["title"],
        json!("Renamed"),
        "single-pane rename mirrors onto tab.title"
    );

    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["t1"]["p1"], json!("Renamed"));
    assert_eq!(
        snap["paneTitleSetByUser"]["t1"]["p1"],
        json!(true),
        "rename is sticky"
    );

    assert_eq!(
        store.rename_pane("missing", "X").message,
        Some("pane not found")
    );
}

#[test]
fn rename_tab_mirrors_to_pane_only_when_single_pane() {
    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }, { "id": "t2" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": leaf("p1", json!({ "kind": "picker" })),
            "t2": split(
                "s1",
                "horizontal",
                [50, 50],
                leaf("p2", json!({ "kind": "picker" })),
                leaf("p3", json!({ "kind": "picker" })),
            ),
        },
        "activePane": { "t1": "p1", "t2": "p2" },
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "c");

    // Single-pane tab: mirror is sticky (layout-store.ts:542-556).
    let out = store.rename_tab("t1", "Solo");
    assert_eq!(out.tab_id.as_deref(), Some("t1"));
    assert_eq!(out.message, None);
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["t1"]["p1"], json!("Solo"));
    assert_eq!(snap["paneTitleSetByUser"]["t1"]["p1"], json!(true));

    // Two-pane tab: tab title changes, pane_titles untouched.
    let out = store.rename_tab("t2", "Duo");
    assert_eq!(out.tab_id.as_deref(), Some("t2"));
    let snap = store.get_normalized_snapshot(None);
    let (rows, _) = store.list_tabs();
    assert_eq!(rows[1]["title"], json!("Duo"));
    assert!(
        snap["paneTitles"].get("t2").is_none(),
        "no pane mirror for multi-pane tabs"
    );

    assert_eq!(store.rename_tab("zzz", "X").message, Some("tab not found"));
}

#[test]
fn next_prev_cycle_ordered_tabs_modulo_len() {
    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }, { "id": "t2" }, { "id": "t3" }],
        "activeTabId": "t3",
        "layouts": {},
        "activePane": {},
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "c");

    assert_eq!(
        store.select_next_tab().as_deref(),
        Some("t1"),
        "next wraps t3 -> t1"
    );
    assert_eq!(
        store.select_prev_tab().as_deref(),
        Some("t3"),
        "prev wraps t1 -> t3"
    );
    assert_eq!(store.select_next_tab().as_deref(), Some("t1"));
    assert_eq!(store.select_next_tab().as_deref(), Some("t2"));

    let empty = LayoutStore::default();
    assert_eq!(empty.select_next_tab(), None);
    assert_eq!(empty.select_prev_tab(), None);
}

#[test]
fn mutations_without_snapshot_report_no_layout_snapshot_but_create_tab_bootstraps() {
    let store = LayoutStore::default();
    assert!(!store.has_snapshot());
    assert_eq!(store.list_tabs(), (Vec::new(), None));
    assert!(!store.has_tab("t1"));

    let out = store.rename_tab("t1", "X");
    assert_eq!(out.message, Some("no layout snapshot"));
    assert!(out.tab_id.is_none());
    assert_eq!(
        store.rename_pane("p1", "X").message,
        Some("no layout snapshot")
    );
    assert_eq!(store.close_tab("t1").message, Some("no layout snapshot"));
    assert_eq!(store.close_pane("p1"), Err("no layout snapshot"));
    assert_eq!(store.swap_pane(None, "a", "b"), Err("no layout snapshot"));
    assert_eq!(store.select_pane(None, "p1"), Err("no layout snapshot"));
    assert_eq!(store.list_panes(None), Err("no layout snapshot"));

    // create_tab bootstraps via ensureSnapshot (layout-store.ts:212-217, 431-460).
    let (tab_id, pane_id) = store.create_tab(Some("Boot"));
    assert!(store.has_snapshot());
    let (rows, active) = store.list_tabs();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(tab_id.clone()));
    assert_eq!(rows[0]["title"], json!("Boot"));
    assert_eq!(rows[0]["activePaneId"], json!(pane_id.clone()));
    assert_eq!(active.as_deref(), Some(tab_id.as_str()));
    assert!(store.has_tab(&tab_id));
    assert!(store.has_tab("Boot"), "has_tab matches title too");

    // The bootstrapped terminal pane seeds the derived "Shell" title.
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(
        snap["paneTitles"][tab_id.as_str()][pane_id.as_str()],
        json!("Shell")
    );

    // Untitled tab rows fall back to the id (layout-store.ts:331).
    let (tab2, _) = store.create_tab(None);
    let (rows, _) = store.list_tabs();
    assert_eq!(rows[1]["title"], json!(tab2.clone()));

    // close_tab purges layouts/activePane/title maps (layout-store.ts:577-587, 87-91).
    let out = store.close_tab(&tab_id);
    assert_eq!(out.tab_id.as_deref(), Some(tab_id.as_str()));
    let snap = store.get_normalized_snapshot(None);
    assert!(snap["layouts"].get(tab_id.as_str()).is_none());
    assert!(snap["activePane"].get(tab_id.as_str()).is_none());
    assert!(snap["paneTitles"].get(tab_id.as_str()).is_none());
    assert_eq!(snap["activeTabId"], json!(tab2));
}

#[test]
fn swap_pane_exchanges_content_and_title_maps() {
    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": split(
                "s1",
                "horizontal",
                [50, 50],
                leaf("p1", json!({ "kind": "terminal", "mode": "claude", "terminalId": "term-1" })),
                leaf("p2", json!({ "kind": "picker" })),
            ),
        },
        "activePane": { "t1": "p1" },
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "c");
    store.rename_pane("p1", "Mine"); // sticky title on p1; p2 has no entries

    assert_eq!(
        store.swap_pane(Some("t1"), "p1", "p2"),
        Ok("t1".to_string())
    );

    // Contents exchanged.
    let p1 = store.get_pane_snapshot("p1").expect("p1 exists");
    assert_eq!(p1.kind.as_deref(), Some("picker"));
    assert_eq!(p1.terminal_id, None);
    let p2 = store.get_pane_snapshot("p2").expect("p2 exists");
    assert_eq!(p2.kind.as_deref(), Some("terminal"));
    assert_eq!(p2.terminal_id.as_deref(), Some("term-1"));

    // Title map entries exchanged with delete-when-missing semantics
    // (layout-store.ts:625-652).
    let snap = store.get_normalized_snapshot(None);
    assert!(snap["paneTitles"]["t1"].get("p1").is_none());
    assert_eq!(snap["paneTitles"]["t1"]["p2"], json!("Mine"));
    assert!(snap["paneTitleSetByUser"]["t1"].get("p1").is_none());
    assert_eq!(snap["paneTitleSetByUser"]["t1"]["p2"], json!(true));

    assert_eq!(store.swap_pane(None, "p1", "zzz"), Err("panes not found"));
}

#[test]
fn close_pane_guards_only_pane_and_purges_metadata() {
    // Single-pane tab: guard.
    let store = LayoutStore::default();
    store.update_from_ui(&single_pane_sync(None, None, 1), "c");
    assert_eq!(store.close_pane("p1"), Err("cannot close only pane"));
    assert_eq!(store.close_pane("zzz"), Err("pane not found"));

    // Two-pane tab: closing p1 collapses to a single leaf and purges p1 metadata.
    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": split(
                "s1",
                "horizontal",
                [50, 50],
                leaf("p1", json!({ "kind": "terminal" })),
                leaf("p2", json!({ "kind": "terminal" })),
            ),
        },
        "activePane": { "t1": "p1" },
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "c");

    // Pre-close PaneRow shape sanity (layout-store.ts:341-355).
    let rows = store.list_panes(None).expect("panes list");
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].id.as_str(), rows[0].index), ("p1", 0));
    assert_eq!((rows[1].id.as_str(), rows[1].index), ("p2", 1));
    assert_eq!(rows[0].kind.as_deref(), Some("terminal"));
    assert_eq!(rows[0].title.as_deref(), Some("Shell"));

    assert_eq!(store.close_pane("p1"), Ok("t1".to_string()));
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["layouts"]["t1"]["type"], json!("leaf"));
    assert_eq!(snap["layouts"]["t1"]["id"], json!("p2"));
    assert_eq!(
        snap["activePane"]["t1"],
        json!("p2"),
        "last remaining pane becomes active"
    );
    assert!(
        snap["paneTitles"]["t1"].get("p1").is_none(),
        "p1 metadata purged"
    );
    assert_eq!(snap["paneTitles"]["t1"]["p2"], json!("Shell"));
    assert_eq!(store.get_single_pane_id("t1").as_deref(), Some("p2"));
}

#[test]
fn normalize_pair_to_hundred_and_percent_bounds() {
    assert_eq!(normalize_pair_to_hundred(30.0, 30.0), [50.0, 50.0]);
    assert_eq!(normalize_pair_to_hundred(25.0, 75.0), [25.0, 75.0]);
    // Clamped to 1..=99 before normalizing (router.ts:608-619).
    assert_eq!(normalize_pair_to_hundred(0.0, 200.0), [1.0, 99.0]);
    assert_eq!(normalize_pair_to_hundred(200.0, 0.0), [99.0, 1.0]);

    assert!(is_valid_percent(1.0));
    assert!(is_valid_percent(50.5));
    assert!(is_valid_percent(99.0));
    assert!(!is_valid_percent(0.0));
    assert!(!is_valid_percent(0.9));
    assert!(!is_valid_percent(100.0));
    assert!(!is_valid_percent(f64::NAN));
    assert!(!is_valid_percent(f64::INFINITY));
}

#[test]
fn derive_pane_title_full_matrix() {
    // editor -> basename | "Editor" (layout-store.ts:96-100)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "/home/u/notes.md" })),
        "notes.md"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "C:\\dir\\main.rs" })),
        "main.rs"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "" })),
        "Editor"
    );
    assert_eq!(derive_pane_title(&json!({ "kind": "editor" })), "Editor");
    assert_eq!(
        derive_pane_title(&json!({ "kind": "editor", "filePath": "/dir/" })),
        "Editor"
    );

    // browser -> hostname | "Browser" (layout-store.ts:102-110)
    assert_eq!(
        derive_pane_title(
            &json!({ "kind": "browser", "url": "https://user:pw@Example.COM:8443/path?q#f" })
        ),
        "example.com"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "browser", "url": "notaurl" })),
        "Browser"
    );
    assert_eq!(derive_pane_title(&json!({ "kind": "browser" })), "Browser");

    // fresh-agent by sessionType (layout-store.ts:112-125)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "freshclaude" })),
        "Freshclaude"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "freshcodex" })),
        "Freshcodex"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "freshopencode" })),
        "OpenCode"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "kilroy" })),
        "Kilroy"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent", "sessionType": "other" })),
        "Fresh Agent"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "fresh-agent" })),
        "Fresh Agent"
    );

    // extension -> extensionName | "Extension" (layout-store.ts:127-131)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "extension", "extensionName": "My Ext" })),
        "My Ext"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "extension", "extensionName": "" })),
        "Extension"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "extension" })),
        "Extension"
    );

    // terminal by mode (layout-store.ts:135-146)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "claude" })),
        "Claude CLI"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "codex" })),
        "Codex CLI"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "gemini" })),
        "Gemini"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "opencode" })),
        "OpenCode"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "mode": "kimi" })),
        "Kimi"
    );

    // ...else by shell (layout-store.ts:147-157)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "powershell" })),
        "PowerShell"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "cmd" })),
        "Command Prompt"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "wsl" })),
        "WSL"
    );
    assert_eq!(
        derive_pane_title(&json!({ "kind": "terminal", "shell": "system" })),
        "Shell"
    );
    assert_eq!(derive_pane_title(&json!({ "kind": "terminal" })), "Shell");

    // host-stats -> fixed title (stateless pane; plan Task 8 arm)
    assert_eq!(
        derive_pane_title(&json!({ "kind": "host-stats" })),
        "Host Stats"
    );

    // non-terminal unknown kinds and non-objects -> no title (Node: undefined)
    assert_eq!(derive_pane_title(&json!({ "kind": "picker" })), "");
    assert_eq!(derive_pane_title(&json!(null)), "");
    assert_eq!(derive_pane_title(&json!("x")), "");
}

#[test]
fn resolve_resize_target_split_id_first_then_pane_parent_split() {
    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": split(
                "s1",
                "horizontal",
                [40, 60],
                leaf("p1", json!({ "kind": "terminal" })),
                leaf("p2", json!({ "kind": "picker" })),
            ),
        },
        "activePane": { "t1": "p1" },
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "c");

    // splitId-first (router.ts:621-647).
    assert_eq!(
        store.resolve_resize_target("s1", None),
        Ok(("t1".to_string(), "s1".to_string(), [40.0, 60.0]))
    );
    assert_eq!(
        store.resolve_resize_target("s1", Some("t1")),
        Ok(("t1".to_string(), "s1".to_string(), [40.0, 60.0]))
    );
    // pane -> parent split.
    assert_eq!(
        store.resolve_resize_target("p2", None),
        Ok(("t1".to_string(), "s1".to_string(), [40.0, 60.0]))
    );
    assert_eq!(
        store.resolve_resize_target("zzz", None),
        Err("split not found")
    );

    assert!(store.resize_split("t1", "s1", [25.0, 75.0]));
    assert!(!store.resize_split("t1", "missing", [25.0, 75.0]));
    assert_eq!(
        store
            .resolve_resize_target("s1", None)
            .map(|(_, _, sizes)| sizes),
        Ok([25.0, 75.0])
    );

    // Ambiguous pane-title target propagates the 409 message (router.ts:634-636).
    let dup = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }, { "id": "t2" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": split(
                "sA",
                "horizontal",
                [50, 50],
                leaf("a1", json!({ "kind": "picker" })),
                leaf("a2", json!({ "kind": "picker" })),
            ),
            "t2": split(
                "sB",
                "horizontal",
                [50, 50],
                leaf("b1", json!({ "kind": "picker" })),
                leaf("b2", json!({ "kind": "picker" })),
            ),
        },
        "activePane": { "t1": "a1", "t2": "b1" },
        "paneTitles": { "t1": { "a1": "Dup" }, "t2": { "b1": "Dup" } },
        "timestamp": 1,
    }));
    dup.update_from_ui(&sync, "c");
    assert_eq!(
        dup.resolve_resize_target("Dup", None),
        Err("pane target is ambiguous; use pane id or tab.pane index")
    );

    assert_eq!(
        LayoutStore::default().resolve_resize_target("s1", None),
        Err("split not found")
    );
}

#[test]
fn split_pane_select_pane_and_attach_content_reseed_derived_titles() {
    let store = LayoutStore::default();
    let (tab_id, pane_id) = store.create_tab(Some("Work"));
    assert_eq!(
        store.get_single_pane_id(&tab_id).as_deref(),
        Some(pane_id.as_str())
    );

    let (split_tab, new_pane) = store.split_pane(&pane_id, "vertical").expect("split works");
    assert_eq!(split_tab, tab_id);
    assert!(store.get_single_pane_id(&tab_id).is_none());

    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["layouts"][tab_id.as_str()]["type"], json!("split"));
    assert_eq!(
        snap["layouts"][tab_id.as_str()]["direction"],
        json!("vertical")
    );
    assert_eq!(snap["layouts"][tab_id.as_str()]["sizes"], json!([50, 50]));
    assert_eq!(snap["activePane"][tab_id.as_str()], json!(new_pane.clone()));
    assert_eq!(
        snap["paneTitles"][tab_id.as_str()][new_pane.as_str()],
        json!("Shell")
    );

    assert_eq!(
        store.select_pane(None, &pane_id),
        Ok((tab_id.clone(), pane_id.clone()))
    );
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["activePane"][tab_id.as_str()], json!(pane_id.clone()));
    assert!(
        store.select_pane(Some(&tab_id), "ghost").is_ok(),
        "Node trusts pane id when tab exists"
    );
    assert_eq!(store.select_pane(None, "ghost"), Err("pane not found"));

    // attach re-seeds the derived title, non-sticky (layout-store.ts:680-694).
    let out = store.attach_pane_content(
        &tab_id,
        &new_pane,
        json!({ "kind": "browser", "url": "https://example.com/x", "devToolsOpen": false }),
    );
    assert_eq!(out.tab_id.as_deref(), Some(tab_id.as_str()));
    assert_eq!(out.pane_id.as_deref(), Some(new_pane.as_str()));
    assert_eq!(out.message, None);
    let pane = store.get_pane_snapshot(&new_pane).expect("pane snapshot");
    assert_eq!(pane.tab_id, tab_id);
    assert_eq!(pane.kind.as_deref(), Some("browser"));
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(
        snap["paneTitles"][tab_id.as_str()][new_pane.as_str()],
        json!("example.com")
    );
    assert!(snap["paneTitleSetByUser"][tab_id.as_str()]
        .get(new_pane.as_str())
        .is_none());

    assert_eq!(
        store.split_pane("missing", "horizontal"),
        Err("pane not found")
    );
    assert_eq!(
        store
            .attach_pane_content("nope", &new_pane, json!({ "kind": "picker" }))
            .message,
        Some("tab not found")
    );
}

// ── multi-client snapshots (the pane-rename cross-client fix) ──────────────
//
// Pane/tab ids are client-local (`nanoid()` per browser/device), so the store
// keeps one snapshot PER client connection. By-id resolution searches the
// PRIMARY (last-writer) snapshot first, then the other clients most-recent
// first; default/active-tab reads stay primary-only (single-client parity).
// This intentionally diverges from Node's single shared snapshot
// (`layout-store.ts:49`, wholesale-replaced by `updateFromUi`, `:169-181`),
// whose last-writer-wins replace made any non-last-writer client's rename
// fail with `pane not found`.

/// One tab/one pane sync payload for a distinct simulated client.
fn client_sync(tab_id: &str, tab_title: &str, pane_id: &str, ts: i64) -> UiLayoutSync {
    sync_from(json!({
        "tabs": [{ "id": tab_id, "title": tab_title }],
        "activeTabId": tab_id,
        "layouts": { tab_id: leaf(pane_id, json!({ "kind": "terminal", "terminalId": format!("term-{pane_id}") })) },
        "activePane": { tab_id: pane_id },
        "timestamp": ts,
    }))
}

#[test]
fn rename_pane_resolves_ids_from_any_client_snapshot() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b"); // last writer

    // THE BUG: a pane from the non-last-writer client must still resolve.
    let out = store.rename_pane("pA", "Renamed A");
    assert_eq!(
        out.message, None,
        "pane from a non-primary client snapshot must resolve"
    );
    assert_eq!(out.tab_id.as_deref(), Some("tA"));
    assert_eq!(out.pane_id.as_deref(), Some("pA"));

    // The last writer keeps working too.
    let out = store.rename_pane("pB", "Renamed B");
    assert_eq!(out.message, None);
    assert_eq!(out.tab_id.as_deref(), Some("tB"));

    // Default reads stay primary-only: the last writer's view.
    let (rows, active) = store.list_tabs();
    assert_eq!(rows.len(), 1, "list_tabs reads the PRIMARY snapshot only");
    assert_eq!(rows[0]["id"], json!("tB"));
    assert_eq!(active.as_deref(), Some("tB"));
}

#[test]
fn by_id_reads_and_mutations_resolve_across_clients() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b"); // primary

    // Reads by id.
    let snap = store
        .get_pane_snapshot("pA")
        .expect("pA resolves via conn-a");
    assert_eq!(snap.tab_id, "tA");
    assert_eq!(snap.terminal_id.as_deref(), Some("term-pA"));
    let rows = store.list_panes(Some("tA")).expect("panes list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "pA");
    assert!(store.has_tab("tA"));
    assert!(store.has_tab("Desktop"));
    assert_eq!(
        resolve_target(&store, "pA"),
        ResolvedTarget::Pane {
            tab_id: "tA".to_string(),
            pane_id: "pA".to_string(),
            message: None,
        }
    );

    // Mutations by id.
    let (tab, new_pane) = store.split_pane("pA", "vertical").expect("split resolves");
    assert_eq!(tab, "tA");
    assert_eq!(store.close_pane(&new_pane), Ok("tA".to_string()));
    assert_eq!(
        store.select_pane(None, "pA"),
        Ok(("tA".to_string(), "pA".to_string()))
    );
    assert_eq!(store.rename_tab("tA", "Desk 2").message, None);

    // Primary reads still answer from the last writer.
    let (rows, _) = store.list_tabs();
    assert_eq!(rows[0]["id"], json!("tB"));
}

#[test]
fn rename_pane_updates_every_client_snapshot_containing_the_id() {
    let store = LayoutStore::default();
    // Two same-origin browser windows share localStorage => identical ids.
    store.update_from_ui(&client_sync("t1", "Shared", "p1", 1), "conn-a");
    store.update_from_ui(&client_sync("t1", "Shared", "p1", 2), "conn-b");

    store.rename_pane("p1", "Both");

    // Visible via the primary (conn-b)…
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["paneTitles"]["t1"]["p1"], json!("Both"));
    // …and STILL visible after the primary disconnects, because conn-a's copy
    // was renamed too (multi-hit mutation).
    store.remove_client("conn-b");
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(
        snap["paneTitles"]["t1"]["p1"],
        json!("Both"),
        "rename must land in every client snapshot containing the id"
    );
    assert_eq!(snap["paneTitleSetByUser"]["t1"]["p1"], json!(true));
}

#[test]
fn normalized_snapshot_with_explicit_tab_id_resolves_from_any_client_snapshot() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b"); // primary

    // `GET /api/layout/snapshot?tabId=`: an explicit tab id from the
    // non-last-writer client must answer with THAT client's tab content.
    let snap = store.get_normalized_snapshot(Some("tA"));
    assert_eq!(
        snap["tabs"][0]["id"],
        json!("tA"),
        "explicit tab id must resolve from conn-a's snapshot: {snap}"
    );
    assert_eq!(snap["activeTabId"], json!("tA"));
    assert_eq!(snap["layouts"]["tA"]["id"], json!("pA"));
    assert_eq!(snap["activePane"]["tA"], json!("pA"));

    // The default (no tab id) read stays primary-only: conn-b's view.
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["activeTabId"], json!("tB"));
    assert_eq!(snap["tabs"][0]["id"], json!("tB"));
    assert!(snap["layouts"].get("tA").is_none());
}

#[test]
fn remove_client_evicts_and_primary_falls_back_to_most_recent_remaining() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b");

    store.remove_client("conn-b");

    // Primary falls back to the most recent LIVE client (conn-a); conn-b's
    // entry is retained as stale, not dropped (Task 5 retention semantics).
    let (rows, active) = store.list_tabs();
    assert_eq!(rows.len(), 1, "default reads answer from the live primary");
    assert_eq!(rows[0]["id"], json!("tA"));
    assert_eq!(active.as_deref(), Some("tA"));
    // conn-b's panes STILL resolve (the silent-reconnect window).
    assert_eq!(store.rename_pane("pB", "X").message, None);
    assert!(store.get_pane_snapshot("pB").is_some());

    // Removing the last live client leaves a fully-stale store that still
    // answers default and by-id reads (Node-parity post-disconnect utility).
    store.remove_client("conn-a");
    assert!(store.has_snapshot());
    assert_eq!(store.rename_pane("pA", "X").message, None);

    // `"no layout snapshot"` only when the store is TRULY empty.
    let empty = LayoutStore::default();
    assert!(!empty.has_snapshot());
    assert_eq!(
        empty.rename_pane("pA", "X").message,
        Some("no layout snapshot")
    );
}

#[test]
fn sole_pane_check_uses_the_snapshot_where_the_pane_resolves() {
    let terminal = json!({ "kind": "terminal" });
    let store = LayoutStore::default();
    // conn-a: tab T is a two-pane split (p1, p2).
    store.update_from_ui(
        &sync_from(json!({
            "tabs": [{ "id": "T", "title": "Shared" }],
            "activeTabId": "T",
            "layouts": { "T": split(
                "s1", "horizontal", [50, 50],
                leaf("p1", terminal.clone()),
                leaf("p2", terminal.clone()),
            ) },
            "activePane": { "T": "p1" },
            "timestamp": 1,
        })),
        "conn-a",
    );
    // conn-b (primary): the SAME tab id, but a single pane pB.
    store.update_from_ui(
        &sync_from(json!({
            "tabs": [{ "id": "T", "title": "Shared" }],
            "activeTabId": "T",
            "layouts": { "T": leaf("pB", terminal) },
            "activePane": { "T": "pB" },
            "timestamp": 2,
        })),
        "conn-b",
    );

    assert!(store.pane_is_sole_in_tab("pB"));
    assert!(
        !store.pane_is_sole_in_tab("p1"),
        "p1 resolves in conn-a where tab T has TWO panes; the primary's \
         same-id single-pane tab must not answer for it"
    );
    assert!(!store.pane_is_sole_in_tab("missing"));
}

#[test]
fn update_from_ui_still_replaces_the_same_clients_snapshot() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("t1", "One", "p1", 1), "conn-a");
    store.update_from_ui(&client_sync("t2", "Two", "p2", 2), "conn-a");

    // Same client re-sync REPLACES its own snapshot (single-client parity
    // with Node's wholesale replace, `layout-store.ts:169-181`).
    assert_eq!(
        store.rename_pane("p1", "X").message,
        Some("pane not found"),
        "the same client's earlier snapshot must not linger"
    );
    assert_eq!(store.rename_pane("p2", "X").message, None);
    let (rows, _) = store.list_tabs();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!("t2"));
}

// ── stale-snapshot retention (the silent-reconnect window fix) ──────────────
//
// The TS client's ONLY `ui.layout.sync` sender (`layoutMirrorMiddleware.ts`)
// is change-gated and never resets on reconnect, so after a silent WS
// reconnect (new conn id, unchanged layout) no re-sync arrives until the next
// layout change. Hard evict-on-disconnect would leave that client's ids
// unresolvable for an unbounded window — so `remove_client` marks the entry
// STALE instead of dropping it. Stale entries are never primary while a live
// client exists; by-id reads/mutations treat them exactly like live ones.

/// One-tab/TWO-pane sync payload (a split) for a distinct simulated client.
fn two_pane_sync(
    tab_id: &str,
    tab_title: &str,
    pane_a: &str,
    pane_b: &str,
    ts: i64,
) -> UiLayoutSync {
    sync_from(json!({
        "tabs": [{ "id": tab_id, "title": tab_title }],
        "activeTabId": tab_id,
        "layouts": { tab_id: split(
            &format!("s-{tab_id}"),
            "horizontal",
            [50, 50],
            leaf(pane_a, json!({ "kind": "terminal" })),
            leaf(pane_b, json!({ "kind": "terminal" })),
        ) },
        "activePane": { tab_id: pane_a },
        "timestamp": ts,
    }))
}

#[test]
fn disconnected_clients_ids_stay_resolvable_until_superseded() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.remove_client("conn-a");

    // The silent-reconnect window: the disconnected client's ids must stay
    // resolvable (no re-sync arrives until the next layout change).
    assert_eq!(
        store.rename_pane("pA", "X").message,
        None,
        "a disconnected client's pane must stay resolvable"
    );
    assert_eq!(store.stale_entry_count(), 1);
    assert_eq!(store.client_entry_count(), 1);

    // The reconnected client re-syncs under a NEW conn id with the same
    // layout: the incoming sync covers EVERY pane id of the stale entry
    // (SUBSET rule), so the stale entry is superseded losslessly.
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 2), "conn-a2");
    assert_eq!(
        store.stale_entry_count(),
        0,
        "a fully-covered stale entry must be evicted by the superseding sync"
    );
    assert_eq!(
        store.client_entry_count(),
        1,
        "exactly one entry containing pA remains"
    );
    assert_eq!(store.rename_pane("pA", "Y").message, None);
}

#[test]
fn live_sync_sharing_only_broadcast_ids_does_not_evict_another_clients_stale_entry() {
    let store = LayoutStore::default();
    // `pS` models a server-minted agent-API id broadcast to EVERY client via
    // `ui.command{tab.create}` — the same id in different clients' snapshots.
    store.update_from_ui(&two_pane_sync("tA", "Desktop", "pA", "pS", 1), "conn-a");
    store.update_from_ui(&two_pane_sync("tB", "Phone", "pB", "pS", 2), "conn-b");
    store.remove_client("conn-a");

    // conn-b live-syncs again — still holding the shared `pS`, never `pA`.
    // One-id overlap is NOT subset coverage: conn-a's stale entry (with its
    // unique locally-minted `pA`) must survive.
    store.update_from_ui(&two_pane_sync("tB", "Phone", "pB", "pS", 3), "conn-b");
    assert_eq!(
        store.stale_entry_count(),
        1,
        "a shared broadcast id must not evict another client's stale entry"
    );
    assert_eq!(store.rename_pane("pA", "Still Here").message, None);
}

#[test]
fn stale_cap_bounds_growth() {
    let store = LayoutStore::default();
    // 5 distinct clients sync, then disconnect (none covers another's ids).
    for i in 1..=5i64 {
        let (tab, title, pane, conn) = (
            format!("t{i}"),
            format!("Tab {i}"),
            format!("p{i}"),
            format!("conn-{i}"),
        );
        store.update_from_ui(&client_sync(&tab, &title, &pane, i), &conn);
        store.remove_client(&conn);
    }

    // Growth safety valve: at most 4 stale entries, oldest dropped.
    assert_eq!(
        store.stale_entry_count(),
        4,
        "stale entries are capped at 4"
    );
    assert_eq!(store.client_entry_count(), 4);
    assert_eq!(
        store.rename_pane("p1", "X").message,
        Some("pane not found"),
        "the OLDEST stale entry is dropped beyond the cap"
    );
    for i in 2..=5i64 {
        let pane = format!("p{i}");
        assert_eq!(
            store.rename_pane(&pane, "X").message,
            None,
            "{pane} must survive the cap"
        );
    }
}

#[test]
fn stale_entry_never_primary_while_live_clients_exist() {
    let store = LayoutStore::default();
    store.update_from_ui(&client_sync("tA", "Desktop", "pA", 1), "conn-a");
    store.update_from_ui(&client_sync("tB", "Phone", "pB", 2), "conn-b");
    store.remove_client("conn-b"); // the MOST RECENT sync goes stale

    // The live client wins default reads even though the stale entry synced
    // later.
    let (rows, active) = store.list_tabs();
    assert_eq!(
        rows[0]["id"],
        json!("tA"),
        "a stale entry must never be primary while a live client exists"
    );
    assert_eq!(active.as_deref(), Some("tA"));

    // With ONLY stale entries left, the most recent stale one answers default
    // reads (Node-parity post-disconnect behavior).
    store.remove_client("conn-a");
    let (rows, active) = store.list_tabs();
    assert_eq!(
        rows[0]["id"],
        json!("tB"),
        "the most recent stale entry answers default reads on a fully-stale store"
    );
    assert_eq!(active.as_deref(), Some("tB"));
}

#[test]
fn update_from_ui_migrates_legacy_agent_chat_and_fresh_agent_content() {
    const CANONICAL: &str = "123e4567-e89b-42d3-a456-426614174000";

    let store = LayoutStore::default();
    let sync = sync_from(json!({
        "tabs": [{ "id": "t1" }, { "id": "t2" }],
        "activeTabId": "t1",
        "layouts": {
            "t1": leaf("p1", json!({ "kind": "agent-chat", "provider": "claude", "resumeSessionId": CANONICAL })),
            "t2": leaf("p2", json!({ "kind": "fresh-agent", "sessionType": "freshopencode", "timelineSessionId": "ses_123" })),
        },
        "activePane": { "t1": "p1", "t2": "p2" },
        "timestamp": 1,
    }));
    store.update_from_ui(&sync, "conn");

    // agent-chat + canonical claude resume -> fresh-agent with sessionRef
    // (shared/fresh-agent.ts:279-334).
    let p1 = store
        .get_pane_snapshot("p1")
        .expect("p1")
        .pane_content
        .expect("content");
    assert_eq!(p1["kind"], json!("fresh-agent"));
    assert_eq!(p1["sessionType"], json!("freshclaude"));
    assert_eq!(p1["provider"], json!("claude"));
    assert_eq!(
        p1["sessionRef"],
        json!({ "provider": "claude", "sessionId": CANONICAL })
    );
    assert_eq!(p1["resumeSessionId"], json!(CANONICAL));
    assert!(p1.get("restoreError").is_none());

    // fresh-agent with legacy timelineSessionId -> sessionRef, legacy key stripped
    // (shared/fresh-agent.ts:199-277).
    let p2 = store
        .get_pane_snapshot("p2")
        .expect("p2")
        .pane_content
        .expect("content");
    assert_eq!(p2["provider"], json!("opencode"));
    assert_eq!(
        p2["sessionRef"],
        json!({ "provider": "opencode", "sessionId": "ses_123" })
    );
    assert!(p2.get("timelineSessionId").is_none(), "legacy key stripped");
    assert!(p2.get("resumeSessionId").is_none());

    // Non-canonical claude resume -> restoreError, no sessionRef/resumeSessionId.
    let store2 = LayoutStore::default();
    let sync2 = sync_from(json!({
        "tabs": [{ "id": "t1" }],
        "layouts": { "t1": leaf("p1", json!({ "kind": "agent-chat", "provider": "claude", "resumeSessionId": "not-a-uuid" })) },
        "activePane": {},
        "timestamp": 1,
    }));
    store2.update_from_ui(&sync2, "c");
    let p = store2
        .get_pane_snapshot("p1")
        .expect("p1")
        .pane_content
        .expect("content");
    assert_eq!(
        p["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" })
    );
    assert!(p.get("sessionRef").is_none());
    assert!(p.get("resumeSessionId").is_none());
}
