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
