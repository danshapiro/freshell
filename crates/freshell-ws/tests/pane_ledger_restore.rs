//! P1.8 read-side integration tests, exercised across server "generations"
//! sharing one ledger dir. Honesty (V7.md/V9.md): Read 1 (inventory
//! stamping) has NO production window today and its test FABRICATES one;
//! Read 3's ledger rung is production-reachable only via the orphaned
//! in-flight-create replay shape until P1.6 — comments on each test say
//! which. Read 2 (`ever_observed`) is live from day one.

mod common;
use common::*;

use freshell_ws::pane_ledger::BindingWrite;

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-read-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn inventory_stamping_falls_back_to_ledger_bound_rows() {
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sleeper CLI spec, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    // Authority chain (spec §4.2 precedence): in-memory registry first,
    // ledger bound rows second. HONESTY (V7.md / A21): this window is
    // FABRICATED — in production today, in-memory identity is written
    // adjacent to every ledger write and survives retirement, so a live
    // terminal with a ledger row but no in-memory identity does not occur;
    // the mainline consumer of this read arrives with Phase 3 / P1.13
    // (REST-created panes). The seam is pinned here so that consumer lands
    // on tested ground.
    let dir = unique_ledger_dir("stamp");
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh codex: no in-memory identity entry is seeded at create.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-1",
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        create.to_string(),
    ))
    .await
    .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    assert!(
        created.get("sessionRef").is_none(),
        "fresh codex has no create-time identity (precondition)"
    );

    // FABRICATE the window (see the test-top comment): seed a bound row for
    // this terminal WITHOUT the in-memory identity upsert that production
    // always performs alongside it. Written through the SERVER'S OWN Arc —
    // with the write-through index, only the server instance's writes are
    // visible to its own reads.
    server_ledger
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            terminal_id: &terminal_id,
            mode: "codex",
            cwd: None,
            create_request_id: Some("req-stamp-1"),
            origin_create_request_id: None,
            provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();

    // A NEW connection's handshake inventory row must now be stamped from
    // the ledger (in-memory identity is still absent).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["terminalId"] == terminal_id.as_str())
        .expect("terminal in inventory");
    assert_eq!(row["sessionRef"]["provider"], "codex");
    assert_eq!(
        row["sessionRef"]["sessionId"],
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_restore_resolves_via_the_ledger_across_a_restart() {
    // The P1.8 ladder rung: generation 1 pre-allocates a claude session id
    // and durably records it; generation 2 (fresh process state) receives
    // restore:true with ONLY the createRequestId and must auto-resume via
    // the ledger instead of rejecting with RESTORE_UNAVAILABLE.
    //
    // HONESTY (V9.md / A11): the production shape that presents the SAME
    // createRequestId across a restart is the ORPHANED IN-FLIGHT CREATE
    // (pane never anchored — no terminalId — replays its persisted id,
    // TerminalView.tsx:4309-4333 / persistMiddleware.ts:229). The mainline
    // browser-closed/cleared-client restores RE-MINT the id and stay on
    // RESTORE_UNAVAILABLE until P1.6. This test's wire shape matches the
    // orphaned-create replay; the rung is an advisory lookup, never an
    // identity join key (spec: "NOT keyed on createRequestId").
    let dir = unique_ledger_dir("ladder");
    use futures_util::SinkExt;

    // --- Generation 1 ---
    let session_id;
    {
        let (url, registry, _ledger1) =
            spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
        let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
        let create = serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-ladder-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        });
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            create.to_string(),
        ))
        .await
        .unwrap();
        let created = next_frame_of_type(&mut ws, "terminal.created").await;
        session_id = created["sessionRef"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        // Kill the PTY so generation 1 dies "abruptly" from the ledger's
        // point of view (registry rows don't survive process death anyway;
        // the ledger row must). NOTE: registry.kill models the PROCESS
        // dying with the server — the ledger row stays BOUND because the
        // wire kill path (handle_kill's retire_closed hygiene) was never
        // invoked.
        let tid = created["terminalId"].as_str().unwrap();
        registry.kill(tid);
    } // generation 1 dropped — its in-memory identity dies with it

    // --- Generation 2, same ledger dir, fresh everything else ---
    let (url2, registry2, _ledger2) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws2, _inv2) = connect_and_capture_inventory(&url2).await;
    let restore = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-ladder-1",
        "mode": "claude",
        "shell": "system",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws2.send(tokio_tungstenite::tungstenite::Message::Text(
        restore.to_string(),
    ))
    .await
    .unwrap();
    let created2 = next_frame_of_type(&mut ws2, "terminal.created").await;
    assert_eq!(
        created2["sessionRef"]["sessionId"].as_str().unwrap(),
        session_id,
        "generation 2 auto-resumed the ledgered identity (never RESTORE_UNAVAILABLE)"
    );
    // Cleanup: don't leave generation 2's sleeper running for 30s.
    registry2.kill(created2["terminalId"].as_str().unwrap());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_restore_still_fails_loud_when_the_ledger_row_was_closed() {
    // Preserved judgment: an explicit user-kill retires the row `closed`;
    // the ladder's ledger rung must NOT resurrect it — fail loud, exactly
    // like the in-process kill path today.
    let dir = unique_ledger_dir("ladder-closed");
    use futures_util::SinkExt;
    let (url, _registry, _ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-closed-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        create.to_string(),
    ))
    .await
    .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid = created["terminalId"].as_str().unwrap().to_string();
    // Explicit USER close (the wire kill path -> retire_closed).
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": tid });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        kill.to_string(),
    ))
    .await
    .unwrap();
    let _ = next_frame_of_type(&mut ws, "terminals.changed").await;

    // Restore of the killed lineage (same requestId, no client id):
    // the registry row is REMOVED by kill, and the ledger row is `closed`
    // -> RESTORE_UNAVAILABLE, same as today.
    let restore = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-closed-1",
        "mode": "claude",
        "shell": "system",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        restore.to_string(),
    ))
    .await
    .unwrap();
    let error = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(
        error["code"],
        serde_json::json!("RESTORE_UNAVAILABLE"),
        "exact wire code: {error}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_restore_is_refused_while_a_rest_shaped_live_claude_owns_the_session() {
    // A13 SAFETY red test (V6.md): a claude whose ONLY footprint is a
    // registry row {mode:"claude", resume_session_id:S, status:Running} —
    // no identity row, no createRequestId lineage. The ledger rung's
    // live-guard must scan registry rows, or it would green-light a second
    // live claude on S.
    //
    // HISTORY (kata hbsa): this was the REST lane's real shape — REST
    // creates never upserted identity.find_by_session and minted no
    // createRequestId. Since Tasks 2+5 the REST lane mints a preallocated
    // id AND writes identity rows + durable ledger bindings through
    // `PaneIdentityBinder` (see tests/rest_claude_identity.rs), so a live
    // REST claude is no longer invisible to the identity arm. The
    // hand-built footprint below (register_headless, no identity upsert)
    // now models the DEGRADED case — an identity/ledger write failure, or
    // a pane from an older server generation — which the registry-row scan
    // must still catch. Still a valid pin; keep it.
    let dir = unique_ledger_dir("ladder-rest-live");
    use futures_util::SinkExt;
    let (url, registry, server_ledger) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    const SESSION: &str = "22222222-3333-4444-8555-666666666666";

    // Forge the REST shape: a live registry row with resume_session_id set
    // but NO identity-registry entry and NO createRequestId. The registry's
    // headless seam (`register_headless`, registry.rs — "crate tests seed
    // live/exited terminal generations deterministically") registers a
    // Running row exactly like freshagent's spawn_terminal_pane leaves one:
    // mode "claude", resume_session_id SESSION, createRequestId None
    // (terminal_tabs.rs:866-877 passes None; :926 set_meta stamps the
    // resume id), and no identity upsert.
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "rest-claude-1".to_string(),
        stream_id: "S-rest-claude-1".to_string(),
        mode: "claude".to_string(),
        resume_session_id: Some(SESSION.to_string()),
        create_request_id: None,
        created_at: None,
    });

    // Seed the ledger with a bound row for the same session, carrying a
    // createRequestId a restore will present. Written via the SERVER'S Arc
    // (write-through index visibility).
    server_ledger
        .record_binding(&BindingWrite {
            provider: "claude",
            session_id: SESSION,
            terminal_id: "gen1-terminal",
            mode: "claude",
            cwd: None,
            create_request_id: Some("req-rest-live-1"),
            origin_create_request_id: None,
            provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
            now_ms: 1_000,
        })
        .unwrap();

    // The restore presents the ledgered requestId. Without the registry
    // scan the rung would answer SESSION and double-resume; with it, the
    // live REST claude is detected -> RESTORE_UNAVAILABLE, fail loud.
    let restore = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-rest-live-1",
        "mode": "claude",
        "shell": "system",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        restore.to_string(),
    ))
    .await
    .unwrap();
    let error = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(
        error["code"],
        serde_json::json!("RESTORE_UNAVAILABLE"),
        "exact wire code: {error}"
    );

    // Cleanup: remove the forged headless row (no real PTY behind it).
    registry.kill("rest-claude-1");
    std::fs::remove_dir_all(&dir).ok();
}
