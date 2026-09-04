//! P1.8 write-trigger integration tests: a REAL axum server + REAL WS client
//! (shared harness), asserting the on-disk ledger rows that identity events
//! must produce — including across a "restart" (a second PaneLedger instance
//! over the same dir; the crate-level shape of the SIGKILL wall tests).

mod common;

use common::{
    connect_and_capture_inventory, connect_and_capture_inventory_with_identity, next_frame_of_type,
    sleeper_cli_spec, spawn_server_with_ledger,
};
use freshell_ws::pane_ledger::{PaneLedger, RetiredReason, RowState};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Next text frame of ANY type. The harness's `next_frame_of_type` drops
/// mismatched frames, which the write-failure test cannot afford (it must
/// capture two frames whose relative order is not guaranteed).
#[cfg(unix)]
async fn next_any_frame(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> serde_json::Value {
    use futures_util::StreamExt;
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(10), ws.next())
            .await
            .expect("frame within 10s")
            .expect("stream open")
            .expect("ws ok");
        if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
            return serde_json::from_str(&text).expect("json frame");
        }
    }
}

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-it-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

/// Poll (≤5s, the spec's wall) until `check` passes — identity durability
/// must be an event-driven guarantee, not a cadence race.
fn wait_for<F: Fn() -> bool>(check: F, what: &str) {
    for _ in 0..50 {
        if check() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("timed out (5s wall) waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_preallocation_writes_a_binding_row_synchronously() {
    // Red test `SIGKILL-within-5s-of-pane-creation`, crate shape: by the
    // time terminal.created is answered, the binding row is on disk — a
    // SIGKILL any moment later cannot lose the identity. (The write runs
    // in an AWAITED spawn_blocking before the reply — same guarantee,
    // off the dispatch task; V1.md.)
    let dir = unique_ledger_dir("claude-prealloc");
    let (url, registry, _ledger_arc) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh claude create — the server pre-allocates the session UUID.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-claude-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // The row must already be durable (the create handler awaits the
    // write before answering).
    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("claude", &session_id)
        .expect("binding row written at create");
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.live_terminal_id.as_deref(), Some(terminal_id.as_str()));
    assert_eq!(row.create_request_id.as_deref(), Some("req-claude-1"));
    assert_eq!(row.mode, "claude");

    // Claude NEVER gets a pending marker — no resolver exists to clear it
    // (the marker trigger is an explicit resolver allowlist; V5.md/V7.md).
    assert!(ledger.pending_for_terminal(&terminal_id).is_none());
    assert!(ledger.list_pending_raw().is_empty());

    // "Restart": a brand-new ledger instance over the same dir still
    // answers — process death cannot lose it (its construction-time index
    // load reads the on-disk rows).
    drop(ledger);
    let gen2 = PaneLedger::new(Some(dir.clone()));
    assert!(gen2.ever_bound("claude", &session_id));

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_claude_resume_create_leaves_prior_binding_row_untouched() {
    // PIN 2 asymmetry guard: the pre-spawn binding write is scoped to the
    // FRESH preallocation only (`claude_fresh_prealloc`). A claude RESUME
    // create whose spawn fails (or loses the duplicate-live race) must NOT
    // rewrite the prior epoch's binding row — pre-spawn there is no evidence
    // the spawn will succeed, and a rewrite would point the durable ledger
    // at a never-spawned terminal. That row's stamps would put it inside its
    // parent client's grace window, so even the D8 parent-relative judgment
    // could surface it as a ghost `ledgerOnly` recovery offer (and it defeats
    // the `pending_for_terminal` reader rule).
    let dir = unique_ledger_dir("claude-resume-fail");
    // A claude spec whose binary does not exist: the PTY spawn fails with
    // NotFound BEFORE any fork (pty.rs resolve contract) — exactly the
    // failing resume create the asymmetry is about.
    let mut broken_claude = sleeper_cli_spec("claude");
    broken_claude.default_cmd = "freshell-test-no-such-claude-binary".to_string();
    let (url, _registry, server_ledger) = spawn_server_with_ledger(vec![broken_claude], &dir).await;

    // Prior epoch: session S is already bound (e.g. written by the epoch
    // that originally owned it). Seed through the SERVER'S Arc so its
    // write-through index sees the row.
    let session_id = "11111111-2222-4333-8444-555555555555";
    let seeded_at = 1_111;
    server_ledger
        .record_binding(&freshell_ws::pane_ledger::BindingWrite {
            provider: "claude",
            session_id,
            terminal_id: "term-prior-epoch",
            mode: "claude",
            cwd: Some("/prior/cwd"),
            create_request_id: Some("req-prior-epoch"),
            provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
            now_ms: seeded_at,
        })
        .expect("seed prior-epoch binding row");
    let seeded = server_ledger
        .load_binding("claude", session_id)
        .expect("seeded row present");

    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-resume-loser",
        "mode": "claude",
        "shell": "system",
        "sessionRef": { "provider": "claude", "sessionId": session_id },
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED");
    assert_eq!(err["requestId"], "req-resume-loser");

    // The prior epoch's row is byte-for-byte untouched: no live_terminal_id
    // / create_request_id rewrite, no last_observed_at bump.
    let after = server_ledger
        .load_binding("claude", session_id)
        .expect("row still present after failed resume create");
    assert_eq!(
        after, seeded,
        "a failed claude RESUME create must not mutate the binding row"
    );
    // And a fresh on-disk reader agrees (durability, not just index state).
    let reread = PaneLedger::new(Some(dir.clone()));
    let disk = reread
        .load_binding("claude", session_id)
        .expect("row on disk");
    assert_eq!(disk.live_terminal_id.as_deref(), Some("term-prior-epoch"));
    assert_eq!(disk.create_request_id.as_deref(), Some("req-prior-epoch"));
    assert_eq!(disk.last_observed_at, seeded_at);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn fresh_identity_bearing_pane_gets_a_pending_marker_at_spawn() {
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sleeper CLI spec, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    // Trigger (d): identity in flight (fresh codex — no resume id) ->
    // durable pending marker from spawn until resolution.
    let dir = unique_ledger_dir("codex-pending");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-1",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    // Durability: a FRESH reader instance (constructed after the write —
    // its index load scans the dir) sees the marker on disk.
    let ledger = PaneLedger::new(Some(dir.clone()));
    let marker = ledger
        .pending_for_terminal(&terminal_id)
        .expect("pending marker written at spawn");
    assert_eq!(marker.mode, "codex");

    // Observed exit IN THIS EPOCH ends the identity-in-flight window: the
    // kill path must delete the marker (spec §4.2 marker GC rule). Poll the
    // SERVER'S OWN ledger Arc — reads answer from the in-memory index, so
    // only the mutating instance observes its own later deletions.
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    wait_for(
        || server_ledger.pending_for_terminal(&terminal_id).is_none(),
        "marker deleted on observed kill",
    );

    let _ = registry; // terminal already killed
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_create_writes_binding_and_kill_retires_it_closed() {
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sleeper CLI spec, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    // Trigger (a/e): a resume create (identity known at spawn) writes the
    // binding row; an explicit user kill retires it `closed`. Delta-r6: the
    // durable close now precedes the process kill and a close-write failure
    // FAILS the kill (the sibling `a_kill_whose_close_write_fails...` pin) —
    // this pin is the success-path half of that contract.
    let dir = unique_ledger_dir("resume-retire");
    let (url, _registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-2",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "codex", "sessionId": "11111111-2222-3333-4444-555555555555" },
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("codex", "11111111-2222-3333-4444-555555555555")
        .expect("resume create wrote the binding");
    assert_eq!(row.state, RowState::Bound);

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    // Poll the SERVER'S ledger Arc (reads are index-backed; only the
    // mutating instance observes its own later writes).
    wait_for(
        || {
            server_ledger
                .load_binding("codex", "11111111-2222-3333-4444-555555555555")
                .is_some_and(|r| {
                    r.state == RowState::Retired && r.retired_reason == Some(RetiredReason::Closed)
                })
        },
        "binding retired closed on user kill",
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_create_stamps_the_binding_row_from_the_connection_identity_and_tab_id() {
    // D8 lane-reach pin (restore-open-sessions-only, review round 3): the WS
    // terminal.create bind lane stamps the ledger row from the connection's
    // hello-stamped identity plus the create's `tabId`; `tabKey` composes as
    // `deviceId:tabId` — exactly `src/lib/tab-registry-snapshot.ts`'s
    // composition, so the row joins the right restored tab later.
    let dir = unique_ledger_dir("prov-stamp");
    let (url, registry, _ledger_arc) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) =
        connect_and_capture_inventory_with_identity(&url, "device-stamp", "client-stamp").await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "tabId": "tab-stamp",
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("claude", &session_id)
        .expect("binding row written at create");
    assert_eq!(row.client_instance_id.as_deref(), Some("client-stamp"));
    assert_eq!(row.device_id.as_deref(), Some("device-stamp"));
    assert_eq!(row.tab_key.as_deref(), Some("device-stamp:tab-stamp"));

    // A tabs.sync.push refreshes the connection's identity (a mid-lifetime
    // clientInstanceId rotation self-heals at the next push instead of
    // waiting out a reconnect): a LATER create off the same socket takes the
    // refreshed stamps.
    let push = serde_json::json!({
        "type": "tabs.sync.push",
        "deviceId": "device-stamp",
        "deviceLabel": "Stamp Device",
        "clientInstanceId": "client-stamp-rotated",
        "snapshotRevision": 2,
        "records": [],
    });
    ws.send(WsMessage::Text(push.to_string())).await.unwrap();
    let create2 = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-2",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "tabId": "tab-stamp-2",
    });
    ws.send(WsMessage::Text(create2.to_string())).await.unwrap();
    let created2 = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id2 = created2["terminalId"].as_str().unwrap().to_string();
    let session_id2 = created2["sessionRef"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    drop(ledger); // constructed before create2; its load-time index is stale
    let ledger = PaneLedger::new(Some(dir.clone()));
    let row2 = ledger
        .load_binding("claude", &session_id2)
        .expect("second binding row written");
    assert_eq!(
        row2.client_instance_id.as_deref(),
        Some("client-stamp-rotated"),
        "the push refreshed the connection identity before this create"
    );
    assert_eq!(row2.device_id.as_deref(), Some("device-stamp"));
    assert_eq!(row2.tab_key.as_deref(), Some("device-stamp:tab-stamp-2"));

    // D8 fold-in (Task 2 review, Minor 2): the GATED restore arm —
    // `create_gate::spawn_gated_restore_create` detaches the create onto a
    // spawned task carrying the connection identity — must stamp the binding
    // row exactly like the inline lane (a resume create exercises
    // handle_create's shared post-spawn bind site through the gate path).
    let session_id3 = "33333333-4444-4555-8666-777777777777";
    let create3 = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-3",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "tabId": "tab-stamp-3",
        "restore": true,
        "sessionRef": { "provider": "claude", "sessionId": session_id3 },
    });
    ws.send(WsMessage::Text(create3.to_string())).await.unwrap();
    let created3 = next_frame_of_type(&mut ws, "terminal.created").await;
    assert_eq!(created3["requestId"], "req-stamp-3");
    let terminal_id3 = created3["terminalId"].as_str().unwrap().to_string();
    drop(ledger); // constructed before create3; its load-time index is stale
    let ledger = PaneLedger::new(Some(dir.clone()));
    let row3 = ledger
        .load_binding("claude", session_id3)
        .expect("gated restore create wrote the binding");
    assert_eq!(
        row3.client_instance_id.as_deref(),
        Some("client-stamp-rotated"),
        "the gated restore lane takes the push-refreshed connection identity"
    );
    assert_eq!(row3.device_id.as_deref(), Some("device-stamp"));
    assert_eq!(row3.tab_key.as_deref(), Some("device-stamp:tab-stamp-3"));

    registry.kill(&terminal_id);
    registry.kill(&terminal_id2);
    registry.kill(&terminal_id3);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn fresh_marker_mode_pane_stamps_the_pending_marker_from_the_connection_identity_and_tab_id() {
    // Delta-r3 Finding 2 (restore-open-sessions-only): a connection-scoped
    // codex CLI create — the DYNAMIC-identity path (no sessionRef, no
    // pre-spawn binding; only claude preallocates) — must stamp the
    // spawn-time PendingMarker with the connection's hello identity + the
    // create's `tabId`. The later locator/candidate resolution is conn-less
    // (`ProvenancePolicy::Inherit`) with NO existing row to inherit from, so
    // the marker's stamps are the ONLY provenance in scope for the binding
    // row it then writes. (codex stands for all MARKER_MODES here: the
    // marker arm is one shared post-spawn call site keyed by mode
    // membership; unit-level coverage is mode-parameterized.)
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises
    // the plain-CLI codex path (sleeper CLI spec, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let dir = unique_ledger_dir("marker-stamp");
    let (url, registry, _ledger_arc) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) =
        connect_and_capture_inventory_with_identity(&url, "device-stamp", "client-stamp").await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-marker-stamp-1",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "tabId": "tab-marker-stamp",
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    // Assert on the DURABLE marker document (the create handler awaits the
    // marker write before answering, exactly like the claude binding-write
    // sibling pins) — the raw JSON, so a missing stamp on an unfixed build
    // fails the test behaviorally rather than being a struct-field gate.
    let entries: Vec<_> = std::fs::read_dir(dir.join("pending"))
        .expect("pending dir exists")
        .collect::<Result<_, _>>()
        .expect("list pending dir");
    assert_eq!(entries.len(), 1, "exactly one marker written");
    let marker: serde_json::Value =
        serde_json::from_slice(&std::fs::read(entries[0].path()).expect("read marker"))
            .expect("marker is json");
    assert_eq!(marker["terminalId"].as_str().unwrap(), terminal_id);
    assert_eq!(marker["mode"].as_str().unwrap(), "codex");
    assert_eq!(
        marker["clientInstanceId"].as_str(),
        Some("client-stamp"),
        "the marker carries the connection's clientInstanceId"
    );
    assert_eq!(
        marker["deviceId"].as_str(),
        Some("device-stamp"),
        "the marker carries the connection's deviceId"
    );
    assert_eq!(
        marker["tabKey"].as_str(),
        Some("device-stamp:tab-marker-stamp"),
        "tabKey composes as deviceId:tabId (src/lib/tab-registry-snapshot.ts)"
    );

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn ledger_write_failure_surfaces_live_and_never_blocks_the_create() {
    // Red test `ledger-write-failure-surfaces-live` (spec §4.2): break the
    // store (read-only dir), create a claude pane. The create MUST succeed
    // (fail loud, degrade to status quo) and a `durability.degraded` frame
    // MUST arrive at failure time — before any restart could make the
    // warning posthumous.
    let dir = unique_ledger_dir("write-fail");
    set_permissions_recursive(&dir, 0o555, 0o555);

    let (url, registry, _ledger_arc) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-fail-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();

    // Both frames arrive; capture order-independently (broadcast vs direct
    // send interleave). next_frame_of_type drops mismatches, so scan for
    // the degraded frame FIRST, then the created frame cannot have been
    // consumed... instead: collect frames until both seen.
    let mut created: Option<serde_json::Value> = None;
    let mut degraded: Option<serde_json::Value> = None;
    for _ in 0..20 {
        let frame = next_any_frame(&mut ws).await; // helper above
        match frame["type"].as_str() {
            Some("terminal.created") => created = Some(frame),
            Some("durability.degraded") => degraded = Some(frame),
            _ => {}
        }
        if created.is_some() && degraded.is_some() {
            break;
        }
    }
    let created = created.expect("create succeeded despite ledger failure");
    let degraded = degraded.expect("durability.degraded pushed LIVE at failure time");
    assert_eq!(degraded["reason"], "ledger_write_failed");
    assert_eq!(degraded["terminalId"], created["terminalId"]);

    let tid = created["terminalId"].as_str().unwrap();
    registry.kill(tid);
    set_permissions_recursive(&dir, 0o755, 0o644);
    std::fs::remove_dir_all(&dir).ok();
}

/// Delta-r6 close-durability ordering (the ws terminal lane): the durable
/// close must precede the process/identity teardown, and a close write that
/// FAILS must FAIL the kill — the terminal stays running, the row stays
/// Bound, and the client gets an error frame (never a silent success over a
/// dead process with a live-looking Bound row). The pre-fix lane ran
/// `kill_and_broadcast` FIRST and merely warned on the write failure — the
/// registry row vanished and no error frame existed. Staging mirrors the
/// create-side sibling above: create with the store writable, then drop the
/// root to read-only so the close's tombstone/retire writes fail.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_whose_close_write_fails_leaves_the_terminal_running_and_answers_with_an_error() {
    // DEV-0006 S5.e: plain-CLI codex path (sleeper CLI spec, no app-server).
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let dir = unique_ledger_dir("kill-close-fail");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let session_id = "11111111-2222-3333-4444-666666666666";
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-kill-close-fail",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "codex", "sessionId": session_id },
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    assert_eq!(
        server_ledger
            .load_binding("codex", session_id)
            .expect("resume create wrote the binding")
            .state,
        RowState::Bound,
        "precondition: the row stands Bound before the kill"
    );

    // Break the store FULLY: write_row_atomic is temp-file+rename
    // (`tabs_persist::atomic_write_durable`), and a rename needs write
    // permission on the row's PARENT directory (`bindings/<enc(provider)>`,
    // two levels down) — so every directory under the root goes read-only
    // recursively. Both halves of the close (the kill tombstone's new file,
    // the row's rename) now fail, and the "nothing durable" assertions below
    // read the honest post-failure disk.
    set_permissions_recursive(&dir, 0o555, 0o555);

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(
        err["code"], "INTERNAL_ERROR",
        "a failed durable close must surface an error frame: {err}"
    );
    assert_eq!(err["terminalId"], terminal_id);

    // Nothing was destroyed: the terminal still runs (self-consistent — a
    // retried kill re-attempts the whole close), never a dead process beside
    // a live-looking Bound row. And NOTHING durable recorded the close: the
    // disk view (read by a fresh ledger instance, bypassing the live server's
    // optimistically-updated write-through index) still has the row Bound
    // with no kill tombstone.
    assert!(
        registry.probe(&terminal_id).is_some(),
        "a failed durable close must leave the terminal running"
    );
    let disk = PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        disk.load_binding("codex", session_id)
            .expect("row on disk")
            .state,
        RowState::Bound,
        "the failed close left nothing durable: the disk row stays Bound"
    );
    assert!(
        disk.kill_tombstone_at("codex", session_id).is_none(),
        "the failed close left no durable kill tombstone"
    );
    assert!(
        disk.list_pane_closes().is_empty(),
        "the failed close left no pane close record"
    );

    // F7 cleanup: restore permissions RECURSIVELY (the nested
    // bindings/<provider> and tombstone dirs stay 0555 under a root-only
    // chmod, which a non-root run cannot remove — the tree leaked).
    set_permissions_recursive(&dir, 0o755, 0o644);
    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

// ── Delta-r6-r2 (focused-episode-6 round 1) ──────────────────────────────

/// F7's helper, hoisted: recursively re-permission a store tree (the
/// failure-staging deny AND the cleanup restore — every nested node must
/// come back, or a non-root run leaks the whole tree: nested `0555` dirs
/// are not removable by the owner).
#[cfg(unix)]
fn set_permissions_recursive(path: &std::path::Path, dir_mode: u32, file_mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(dir_mode)).unwrap();
    if path.is_dir() {
        for entry in std::fs::read_dir(path).unwrap().flatten() {
            if entry.path().is_dir() {
                set_permissions_recursive(&entry.path(), dir_mode, file_mode);
            } else {
                std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(file_mode))
                    .unwrap();
            }
        }
    }
}

/// F1+F2, the whole terminal lane end to end: a kill landing BEFORE identity
/// resolution (the marker-mode pane never identifies) records the close
/// under the PANE identity any later verdict can join on — and a resolution
/// arriving after the kill consults that record and lands its row
/// Retired(Closed), never Bound.
#[tokio::test]
async fn a_kill_before_identity_resolution_records_a_pane_close_the_late_resolution_adopts() {
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let dir = unique_ledger_dir("kill-preidentity");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // A codex-mode create with NO sessionRef: the pending marker is the only
    // evidence (identity arrives via the locator/signal lanes — never, for a
    // sleeper CLI).
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-kill-preidentity",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    wait_for(
        || {
            server_ledger
                .list_pending_raw()
                .iter()
                .any(|m| m.terminal_id == terminal_id)
        },
        "the pending marker to land (identity in flight)",
    );
    assert!(
        server_ledger.list_bindings().is_empty(),
        "precondition: no binding row exists (identity never resolved)"
    );

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    // Yield to the runtime until the close lands (kill → spawn_blocking →
    // record write). `wait_for` uses thread::sleep, which would starve a
    // single-threaded test runtime — drain frames instead (terminal.exit /
    // terminals.changed arrive on the success path).
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while server_ledger.pane_close_for_terminal(&terminal_id).is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the pane close record never landed — the durable close under the pane's own identity"
        );
        let _ = tokio::time::timeout(std::time::Duration::from_millis(200), ws.next()).await;
    }
    let record = server_ledger
        .pane_close_for_terminal(&terminal_id)
        .expect("close record");
    assert_eq!(record.terminal_id, terminal_id);
    assert_eq!(
        record.create_request_id.as_deref(),
        Some("req-kill-preidentity"),
        "the record carries the pane's createRequestId (the verdict join key)"
    );
    assert!(
        !server_ledger
            .list_pending_raw()
            .iter()
            .any(|m| m.terminal_id == terminal_id),
        "the marker is deleted by the kill"
    );
    assert!(
        server_ledger.list_bindings().is_empty(),
        "still no row (nothing identified before the kill)"
    );

    // NOW the orphaned resolution lands (the locator lane's shape: binding
    // row + marker delete) — it must consult the close record and land the
    // row Retired(Closed), folding the identity's fence and the record.
    let resolve_ledger = std::sync::Arc::clone(&server_ledger);
    let tid = terminal_id.clone();
    tokio::task::spawn_blocking(move || {
        resolve_ledger.resolve_pending(&freshell_ws::pane_ledger::BindingWrite {
            provider: "codex",
            session_id: "sess-late-resolve",
            terminal_id: &tid,
            mode: "codex",
            cwd: Some("/tmp"),
            create_request_id: None,
            provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
            now_ms: 9_000,
        })
    })
    .await
    .expect("join")
    .expect("the resolve write succeeds (it lands as retired evidence)");
    let row = server_ledger
        .load_binding("codex", "sess-late-resolve")
        .expect("the resolved row exists");
    assert_eq!(
        row.state,
        freshell_ws::pane_ledger::RowState::Retired,
        "the late resolution lands Retired, never Bound"
    );
    assert_eq!(row.retired_reason, Some(RetiredReason::Closed));
    assert!(
        server_ledger.kill_tombstone_at("codex", "sess-late-resolve").is_some(),
        "the identity's kill fence folded"
    );
    let record = server_ledger
        .pane_close_for_terminal(&terminal_id)
        .expect("record");
    assert!(
        record
            .kills
            .iter()
            .any(|k| k.provider == "codex" && k.session_id == "sess-late-resolve"),
        "the record learned the now-known identity: {record:?}"
    );
    let _ = registry; // ownership only (terminal already reaped by the kill)
    std::fs::remove_dir_all(&dir).ok();
}

/// F6, the terminal half through the REAL failure surface: only the ROW
/// retire write can fail (its bindings dir read-only; the tombstone's tree
/// stays writable). The compensated close must NOT leave the just-written
/// tombstone dominating the still-Bound row — the kill answers with an
/// error, the terminal runs, and the disk shows row Bound + NO tombstone +
/// NO close record.
#[cfg(unix)]
#[tokio::test]
async fn a_kill_whose_row_retire_fails_compensates_the_just_written_tombstone() {
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let dir = unique_ledger_dir("kill-partial-close");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let session_id = "11111111-2222-3333-4444-777777777777";
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-kill-partial-close",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "codex", "sessionId": session_id },
    });
    ws.send(WsMessage::Text(create.to_string())).await.unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    assert_eq!(
        server_ledger
            .load_binding("codex", session_id)
            .expect("resume create wrote the binding")
            .state,
        RowState::Bound,
        "precondition: the row stands Bound before the kill"
    );

    // Only the row's bindings dir goes read-only: the tombstone can land,
    // the retire cannot (its rename needs dir-write).
    let bindings_dir = dir.join("bindings").join("codex");
    set_permissions_recursive(&bindings_dir, 0o555, 0o555);

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(WsMessage::Text(kill.to_string())).await.unwrap();
    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(
        err["code"], "INTERNAL_ERROR",
        "a failed durable close surfaces an error frame: {err}"
    );
    assert_eq!(err["terminalId"], terminal_id);

    assert!(
        registry.probe(&terminal_id).is_some(),
        "a failed close leaves the terminal running"
    );
    let disk = PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        disk.load_binding("codex", session_id)
            .expect("row on disk")
            .state,
        RowState::Bound,
        "the row was never retired — no mis-restore"
    );
    assert!(
        disk.kill_tombstone_at("codex", session_id).is_none(),
        "compensation removed the just-written tombstone: no dominance over the live session"
    );
    assert!(
        disk.list_pane_closes().is_empty(),
        "no close record exists for a close that failed"
    );

    set_permissions_recursive(&dir, 0o755, 0o644);
    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}
