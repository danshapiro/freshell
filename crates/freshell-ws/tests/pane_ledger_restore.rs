//! P1.8 read-side integration tests, exercised across server "generations"
//! sharing one ledger dir. Honesty (V7.md/V9.md): Read 1 (inventory
//! stamping) has NO production window today and its test FABRICATES one;
//! Read 3's ledger rung is production-reachable only via the orphaned
//! in-flight-create replay shape until P1.6 — comments on each test say
//! which. Read 2 (`ever_observed`) is live from day one.

mod common;
use common::*;

use freshell_recovery::{MaterializationState, RecoveryOwnerKey};
use freshell_ws::pane_ledger::{owner_v2_filename, BindingWrite, FreshAgentBindingWrite};

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
            provider_scope: None,
            materialization: MaterializationState::Observed,
            terminal_id: &terminal_id,
            mode: "codex",
            cwd: None,
            create_request_id: Some("req-stamp-1"),
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
async fn pane_ledger_claude_preallocation_is_allocated_and_restores_across_restart() {
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
        let (url, registry, ledger1) =
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
        assert_eq!(
            ledger1.materialization_for_owner(&owner("claude", &session_id, None)),
            MaterializationState::Allocated,
            "a minted --session-id is reserved but not yet provider-observed"
        );
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
    // A13 SAFETY red test (V6.md): a claude resumed via the freshagent REST
    // API is invisible to identity.find_by_session (never upserted) AND to
    // createRequestId lineage (REST mints none) — its ONLY footprint is a
    // registry row {mode:"claude", resume_session_id:S, status:Running}.
    // The ledger rung's live-guard must scan registry rows, or it would
    // green-light a second live claude on S.
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
            provider_scope: None,
            materialization: MaterializationState::Observed,
            terminal_id: "gen1-terminal",
            mode: "claude",
            cwd: None,
            create_request_id: Some("req-rest-live-1"),
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

fn owner(provider: &str, session_id: &str, provider_scope: Option<&str>) -> RecoveryOwnerKey {
    RecoveryOwnerKey {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        provider_scope: provider_scope.map(str::to_string),
    }
}

fn durable_write<'a>(
    owner: &'a RecoveryOwnerKey,
    terminal_id: &'a str,
    cwd: Option<&'a str>,
    materialization: MaterializationState,
    now_ms: i64,
) -> BindingWrite<'a> {
    BindingWrite {
        provider: &owner.provider,
        session_id: &owner.session_id,
        provider_scope: owner.provider_scope.as_deref(),
        materialization,
        terminal_id,
        mode: &owner.provider,
        cwd,
        create_request_id: None,
        now_ms,
    }
}

#[test]
fn pane_ledger_materialization_loads_old_rows_as_unknown_and_advances_monotonically() {
    let dir = unique_ledger_dir("materialization");
    let legacy_dir = dir.join("bindings").join("claude");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        legacy_dir.join("legacy-session.json"),
        br#"{"ledgerVersion":1,"provider":"claude","sessionId":"legacy-session","mode":"claude","createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound"}"#,
    )
    .unwrap();

    let owner = owner("claude", "legacy-session", None);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        ledger.materializations_for_owners(std::slice::from_ref(&owner)),
        vec![MaterializationState::Unknown],
        "a pre-field row must not fabricate provider observation"
    );

    ledger
        .record_binding(&durable_write(
            &owner,
            "terminal-1",
            Some("/project/a"),
            MaterializationState::Allocated,
            2,
        ))
        .unwrap();
    assert_eq!(
        ledger.materialization_for_owner(&owner),
        MaterializationState::Allocated
    );

    ledger
        .mark_materialized(&owner, 3)
        .expect("provider proof is persisted");
    ledger
        .record_binding(&durable_write(
            &owner,
            "terminal-1",
            Some("/project/b"),
            MaterializationState::Allocated,
            4,
        ))
        .expect("a later allocation refresh cannot regress observation");
    assert_eq!(
        ledger.materialization_for_owner(&owner),
        MaterializationState::Observed
    );
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        reloaded.materialization_for_owner(&owner),
        MaterializationState::Observed
    );
    let disabled = freshell_ws::pane_ledger::PaneLedger::disabled();
    assert_eq!(
        disabled.materialization_for_owner(&owner),
        MaterializationState::Unknown,
        "disabled and lock-failed ledgers cannot claim observation"
    );
    assert!(
        disabled.mark_materialized(&owner, 5).is_err(),
        "exact recovery must retry when observation cannot be persisted"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_global_owners_ignore_cwd_and_batch_preserves_request_order() {
    let dir = unique_ledger_dir("global-batch");
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let claude = owner("claude", "global-session", None);
    ledger
        .record_binding(&durable_write(
            &claude,
            "terminal-1",
            Some("/first"),
            MaterializationState::Allocated,
            1,
        ))
        .unwrap();
    ledger
        .record_binding(&durable_write(
            &claude,
            "terminal-1",
            Some("/second"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();

    assert_eq!(
        ledger
            .list_bindings()
            .into_iter()
            .filter(|row| row.provider == "claude" && row.session_id == "global-session")
            .count(),
        1,
        "cwd is resume metadata, not part of a global provider owner"
    );
    let mut owners = vec![claude.clone(); 17];
    owners[8] = owner("codex", "missing", None);
    let states = ledger.materializations_for_owners(&owners);
    assert_eq!(states.len(), 17);
    assert_eq!(states[0], MaterializationState::Observed);
    assert_eq!(states[8], MaterializationState::Unknown);
    assert_eq!(states[16], MaterializationState::Observed);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_materialization_batch_is_partial_retry_safe_for_seventeen_owners() {
    let dir = unique_ledger_dir("materialization-batch-retry");
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let owners = (0..17)
        .map(|index| owner("codex", &format!("session-{index:02}"), None))
        .collect::<Vec<_>>();
    for (index, owner) in owners.iter().enumerate() {
        ledger
            .record_binding(&durable_write(
                owner,
                &format!("terminal-{index:02}"),
                Some("/project"),
                MaterializationState::Allocated,
                1,
            ))
            .unwrap();
    }

    let blocked_owner = &owners[8];
    let blocked_path = dir
        .join("bindings")
        .join("v2")
        .join(owner_v2_filename(blocked_owner));
    std::fs::remove_file(&blocked_path).unwrap();
    std::fs::create_dir(&blocked_path).unwrap();
    let mut request = owners.clone();
    request.push(owners[0].clone());
    assert!(
        ledger.mark_materialized_many(&request, 2).is_err(),
        "one row failure propagates so exact recovery can retry"
    );
    let partial = ledger.materializations_for_owners(&owners);
    assert!(partial[..8]
        .iter()
        .all(|state| *state == MaterializationState::Observed));
    assert!(partial[8..]
        .iter()
        .all(|state| *state == MaterializationState::Allocated));

    std::fs::remove_dir(&blocked_path).unwrap();
    ledger
        .mark_materialized_many(&request, 3)
        .expect("retry completes only the remaining monotonic writes");
    assert!(ledger
        .materializations_for_owners(&owners)
        .into_iter()
        .all(|state| state == MaterializationState::Observed));

    drop(ledger);
    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(reloaded
        .materializations_for_owners(&owners)
        .into_iter()
        .all(|state| state == MaterializationState::Observed));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_scoped_amplifier_owners_coexist_reload_and_use_short_hashed_filenames() {
    let dir = unique_ledger_dir("amplifier-scopes");
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let maximum_portable_id = format!("{}a", "é".repeat(127));
    let long_scope_a = format!("/normalized/{}", "界".repeat(400));
    let long_scope_b = format!("/normalized/{}", "別".repeat(400));
    let owner_a = owner("amplifier", &maximum_portable_id, Some(&long_scope_a));
    let owner_b = owner("amplifier", &maximum_portable_id, Some(&long_scope_b));

    ledger
        .record_binding(&durable_write(
            &owner_a,
            "terminal-a",
            Some("/raw/a"),
            MaterializationState::Observed,
            1,
        ))
        .unwrap();
    ledger
        .record_binding(&durable_write(
            &owner_b,
            "terminal-b",
            Some("/raw/b"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        reloaded
            .load_binding_for_owner(&owner_a)
            .and_then(|row| row.cwd),
        Some("/raw/a".to_string())
    );
    assert_eq!(
        reloaded
            .load_binding_for_owner(&owner_b)
            .and_then(|row| row.cwd),
        Some("/raw/b".to_string())
    );

    let filenames: Vec<_> = std::fs::read_dir(dir.join("bindings").join("v2"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(filenames.len(), 2);
    for filename in filenames {
        assert!(filename.starts_with("owner-v2-"));
        assert!(filename.ends_with(".json"));
        assert_eq!(filename.len(), 78);
        assert!(!filename.contains(&maximum_portable_id));
        assert!(!filename.contains('%'));
    }
    assert_eq!(
        owner_v2_filename(&owner(
            "claude",
            "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
            None,
        )),
        "owner-v2-0e6fc66c8973331faf7a0adabd5e90eb7b8676e303055f7bc191b48546ac3b42.json",
        "the domain-separated, length-framed digest is a stable disk contract"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_unscoped_amplifier_alias_never_authorizes_and_migration_is_retryable() {
    let dir = unique_ledger_dir("amplifier-alias");
    let legacy_dir = dir.join("bindings").join("amplifier");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    let legacy_path = legacy_dir.join("shared-id.json");
    std::fs::write(
        &legacy_path,
        br#"{"ledgerVersion":1,"provider":"amplifier","sessionId":"shared-id","mode":"freshamplifier","cwd":"/old/raw","createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound","paneKind":"fresh-agent"}"#,
    )
    .unwrap();
    let scoped = owner("amplifier", "shared-id", Some("/normalized/project"));
    let legacy_alias = owner("amplifier", "shared-id", None);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(ledger.load_binding_for_owner(&scoped).is_none());
    assert_eq!(
        ledger.materialization_for_owner(&legacy_alias),
        MaterializationState::Unknown,
        "an old unscoped alias is never upgraded to an allocation claim"
    );
    assert_eq!(
        ledger.materialization_for_owner(&scoped),
        MaterializationState::Unknown
    );

    let destination = dir
        .join("bindings")
        .join("v2")
        .join(owner_v2_filename(&scoped));
    std::fs::create_dir_all(&destination).unwrap();
    assert!(
        ledger
            .record_binding(&durable_write(
                &scoped,
                "terminal-scoped",
                Some("/new/raw"),
                MaterializationState::Observed,
                2,
            ))
            .is_err(),
        "a successor write failure remains retryable and cannot bless the alias"
    );
    assert!(legacy_path.is_file());
    assert!(ledger.load_binding_for_owner(&scoped).is_none());

    std::fs::remove_dir(&destination).unwrap();
    ledger
        .record_binding(&durable_write(
            &scoped,
            "terminal-scoped",
            Some("/new/raw"),
            MaterializationState::Observed,
            3,
        ))
        .expect("retry writes a scoped successor");
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(legacy_path.is_file(), "migration never deletes the alias");
    assert!(
        reloaded.load_binding_for_owner(&legacy_alias).is_none(),
        "a scoped successor removes its matching unscoped alias from effective reads"
    );
    assert!(
        reloaded.list_bindings().into_iter().all(|row| {
            !(row.provider == "amplifier"
                && row.session_id == "shared-id"
                && row.provider_scope.is_none())
        }),
        "scope-blind inventory reads must not rediscover a shadowed alias"
    );
    assert_eq!(
        reloaded.materialization_for_owner(&legacy_alias),
        MaterializationState::Unknown
    );
    assert_eq!(
        reloaded
            .load_binding_for_owner(&scoped)
            .and_then(|row| row.cwd),
        Some("/new/raw".to_string()),
        "the scoped successor wins after a crash/reload"
    );
    assert_eq!(
        reloaded.materialization_for_owner(&scoped),
        MaterializationState::Observed
    );
    reloaded
        .record_binding(&durable_write(
            &scoped,
            "terminal-scoped",
            Some("/new/raw"),
            MaterializationState::Observed,
            4,
        ))
        .expect("post-crash migration retry is idempotent");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_scoped_successor_survives_a_failure_after_its_durable_write() {
    let dir = unique_ledger_dir("amplifier-alias-post-write-failure");
    let legacy_dir = dir.join("bindings").join("amplifier");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    let legacy_path = legacy_dir.join("shared-id.json");
    let legacy_bytes = br#"{"ledgerVersion":1,"provider":"amplifier","sessionId":"shared-id","mode":"freshamplifier","cwd":"/old/raw","createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound","paneKind":"fresh-agent"}"#;
    std::fs::write(&legacy_path, legacy_bytes).unwrap();

    let previous = owner("amplifier", "previous-id", Some("/normalized/project"));
    let successor = owner("amplifier", "shared-id", Some("/normalized/project"));
    let alias = owner("amplifier", "shared-id", None);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &previous,
            "terminal-scoped",
            Some("/old/raw"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();

    // Force the second persistence step (retiring the previous terminal
    // owner) to fail. The scoped successor is written first by contract.
    let previous_path = dir
        .join("bindings")
        .join("v2")
        .join(owner_v2_filename(&previous));
    std::fs::remove_file(&previous_path).unwrap();
    std::fs::create_dir(&previous_path).unwrap();
    assert!(
        ledger
            .record_binding(&durable_write(
                &successor,
                "terminal-scoped",
                Some("/new/raw"),
                MaterializationState::Observed,
                3,
            ))
            .is_err(),
        "a failure after the successor write must remain retryable"
    );
    let successor_path = dir
        .join("bindings")
        .join("v2")
        .join(owner_v2_filename(&successor));
    assert!(
        successor_path.is_file(),
        "the failure occurs only after the scoped successor is durable"
    );
    assert_eq!(std::fs::read(&legacy_path).unwrap(), legacy_bytes);
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(
        reloaded.load_binding_for_owner(&alias).is_none(),
        "reload must not let the compatibility alias shadow the durable successor"
    );
    assert_eq!(
        reloaded
            .load_binding_for_owner(&successor)
            .map(|row| row.materialization),
        Some(MaterializationState::Observed)
    );
    reloaded
        .record_binding(&durable_write(
            &successor,
            "terminal-scoped",
            Some("/new/raw"),
            MaterializationState::Observed,
            4,
        ))
        .expect("retry after reload is idempotent");
    assert_eq!(
        std::fs::read(&legacy_path).unwrap(),
        legacy_bytes,
        "migration never mutates the legacy alias"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_forged_v2_unscoped_amplifier_row_never_authorizes() {
    let dir = unique_ledger_dir("amplifier-forged-v2-unscoped");
    let alias = owner("amplifier", "shared-id", None);
    let v2_dir = dir.join("bindings").join("v2");
    std::fs::create_dir_all(&v2_dir).unwrap();
    std::fs::write(
        v2_dir.join(owner_v2_filename(&alias)),
        serde_json::to_vec(&serde_json::json!({
            "ledgerVersion": 1,
            "provider": "amplifier",
            "sessionId": "shared-id",
            "materialization": "observed",
            "mode": "freshamplifier",
            "cwd": "/raw/project",
            "createdAt": 1,
            "updatedAt": 1,
            "lastObservedAt": 1,
            "state": "bound",
            "paneKind": "fresh-agent"
        }))
        .unwrap(),
    )
    .unwrap();

    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        ledger.materialization_for_owner(&alias),
        MaterializationState::Unknown,
        "even a filename-valid v2 row cannot grant unscoped Amplifier authority"
    );
    assert_eq!(
        ledger
            .load_binding_for_owner(&alias)
            .map(|row| row.materialization),
        Some(MaterializationState::Unknown)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_rejects_illegal_provider_scope_shapes_on_write_and_v2_load() {
    let dir = unique_ledger_dir("illegal-provider-scopes");
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let illegally_scoped_claude = owner("claude", "claude-id", Some("/illegal/scope"));
    let illegally_scoped_codex = owner("codex", "codex-id", Some("/illegal/scope"));
    let illegally_scoped_opencode = owner("opencode", "opencode-id", Some("/illegal/scope"));
    let empty_amplifier_scope = owner("amplifier", "amplifier-id", Some(""));
    let illegal_owners = [
        &illegally_scoped_claude,
        &illegally_scoped_codex,
        &illegally_scoped_opencode,
        &empty_amplifier_scope,
    ];

    for (index, illegal_owner) in illegal_owners.into_iter().enumerate() {
        let error = ledger
            .record_binding(&durable_write(
                illegal_owner,
                &format!("terminal-{index}"),
                Some("/raw/project"),
                MaterializationState::Observed,
                1,
            ))
            .expect_err("noncanonical owner scope must be rejected at the write boundary");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
    for illegal_owner in [&illegally_scoped_codex, &empty_amplifier_scope] {
        let error = ledger
            .record_fresh_agent_binding(&FreshAgentBindingWrite {
                provider: &illegal_owner.provider,
                session_id: &illegal_owner.session_id,
                provider_scope: illegal_owner.provider_scope.as_deref(),
                materialization: MaterializationState::Observed,
                mode: &illegal_owner.provider,
                cwd: Some("/raw/project"),
                create_request_id: None,
                model: None,
                sandbox: None,
                permission_mode: None,
                effort: None,
                supersedes: None,
                now_ms: 1,
            })
            .expect_err("fresh-agent writes must enforce the same canonical owner boundary");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
    drop(ledger);

    let v2_dir = dir.join("bindings").join("v2");
    std::fs::create_dir_all(&v2_dir).unwrap();
    for illegal_owner in illegal_owners {
        std::fs::write(
            v2_dir.join(owner_v2_filename(illegal_owner)),
            serde_json::to_vec(&serde_json::json!({
                "ledgerVersion": 1,
                "provider": illegal_owner.provider,
                "sessionId": illegal_owner.session_id,
                "providerScope": illegal_owner.provider_scope,
                "materialization": "observed",
                "mode": illegal_owner.provider,
                "cwd": "/raw/project",
                "createdAt": 1,
                "updatedAt": 1,
                "lastObservedAt": 1,
                "state": "bound"
            }))
            .unwrap(),
        )
        .unwrap();
    }

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    for illegal_owner in illegal_owners {
        assert!(
            reloaded.load_binding_for_owner(illegal_owner).is_none(),
            "a forged noncanonical owner must not enter the effective index"
        );
    }
    let report = reloaded.boot_scan(2, &|_, _| false);
    assert_eq!(
        report.quarantined.len(),
        illegal_owners.len(),
        "every digest-valid but noncanonical v2 row is quarantined loudly"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_gc_never_resurrects_a_shadowed_legacy_binding() {
    let dir = unique_ledger_dir("legacy-shadow-gc");
    let legacy_dir = dir.join("bindings").join("claude");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        legacy_dir.join("shared-session.json"),
        br#"{"ledgerVersion":1,"provider":"claude","sessionId":"shared-session","materialization":"unknown","mode":"claude","createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound"}"#,
    )
    .unwrap();

    let key = owner("claude", "shared-session", None);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &key,
            "terminal-v2",
            Some("/new"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();
    let expire_at = 2 + freshell_ws::pane_ledger::BOUND_GC_TTL_MS + 1;
    ledger.gc(expire_at, &|_, _| false, None);
    let delete_at = expire_at + freshell_ws::pane_ledger::TOMBSTONE_GC_TTL_MS + 1;
    let report = ledger.gc(delete_at, &|_, _| true, None);

    assert!(
        report.tombstones_deleted.is_empty(),
        "the v2 suppressor must remain while its read-only legacy alias exists"
    );
    let effective = ledger.load_binding_for_owner(&key).unwrap();
    assert_eq!(effective.state, freshell_ws::pane_ledger::RowState::Retired);
    assert_eq!(
        effective.retired_reason,
        Some(freshell_ws::pane_ledger::RetiredReason::GcExpired)
    );

    drop(ledger);
    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert_eq!(
        reloaded.load_binding_for_owner(&key).unwrap().state,
        freshell_ws::pane_ledger::RowState::Retired,
        "restart must not restore authority from the shadowed legacy file"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_gc_never_reexposes_a_shadowed_unscoped_v2_amplifier_row() {
    let dir = unique_ledger_dir("amplifier-v2-shadow-gc");
    let alias = owner("amplifier", "shared-id", None);
    let scoped = owner("amplifier", "shared-id", Some("/normalized/project"));
    let v2_dir = dir.join("bindings").join("v2");
    std::fs::create_dir_all(&v2_dir).unwrap();
    std::fs::write(
        v2_dir.join(owner_v2_filename(&alias)),
        serde_json::to_vec(&serde_json::json!({
            "ledgerVersion": 1,
            "provider": "amplifier",
            "sessionId": "shared-id",
            "materialization": "unknown",
            "mode": "freshamplifier",
            "cwd": "/old/raw",
            "createdAt": 1,
            "updatedAt": 1,
            "lastObservedAt": 1,
            "state": "bound",
            "paneKind": "fresh-agent"
        }))
        .unwrap(),
    )
    .unwrap();

    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &scoped,
            "terminal-scoped",
            Some("/new/raw"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();
    assert!(ledger.load_binding_for_owner(&alias).is_none());

    let expire_at = 2 + freshell_ws::pane_ledger::BOUND_GC_TTL_MS + 1;
    ledger.gc(expire_at, &|_, _| false, None);
    let delete_at = expire_at + freshell_ws::pane_ledger::TOMBSTONE_GC_TTL_MS + 1;
    assert!(
        ledger
            .gc(delete_at, &|_, _| true, None)
            .tombstones_deleted
            .is_empty(),
        "the scoped suppressor must remain while an unscoped v2 alias exists"
    );

    drop(ledger);
    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(reloaded.load_binding_for_owner(&alias).is_none());
    assert_eq!(
        reloaded.load_binding_for_owner(&scoped).unwrap().state,
        freshell_ws::pane_ledger::RowState::Retired
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_unscoped_amplifier_write_cannot_retire_a_scoped_owner() {
    let dir = unique_ledger_dir("amplifier-unscoped-write");
    let scoped = owner("amplifier", "shared-id", Some("/normalized/project"));
    let alias = owner("amplifier", "shared-id", None);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &scoped,
            "terminal-1",
            Some("/raw/project"),
            MaterializationState::Observed,
            1,
        ))
        .unwrap();

    ledger
        .record_binding(&durable_write(
            &alias,
            "terminal-1",
            Some("/raw/project"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();

    let effective = ledger.load_binding_for_owner(&scoped).unwrap();
    assert_eq!(effective.state, freshell_ws::pane_ledger::RowState::Bound);
    assert_eq!(effective.materialization, MaterializationState::Observed);
    assert!(
        ledger.load_binding_for_owner(&alias).is_none(),
        "the compatibility write remains ineffective"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_scoped_lifecycle_apis_use_the_complete_owner() {
    let dir = unique_ledger_dir("amplifier-scoped-lifecycle");
    let old = owner("amplifier", "old-id", Some("/normalized/project"));
    let new = owner("amplifier", "new-id", Some("/normalized/project"));
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &old,
            "terminal-1",
            Some("/raw/project"),
            MaterializationState::Observed,
            1,
        ))
        .unwrap();
    ledger
        .record_binding(&durable_write(
            &new,
            "terminal-1",
            Some("/raw/project"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();

    let resolution = ledger.lookup_by_owner(&old).expect("scoped predecessor");
    assert!(resolution.corrected);
    assert_eq!(resolution.row.provider, new.provider);
    assert_eq!(resolution.row.session_id, new.session_id);
    assert_eq!(resolution.row.provider_scope, new.provider_scope);
    assert!(ledger.ever_bound_owner(&old));
    assert!(ledger.ever_bound_owner(&new));
    assert!(
        ledger.lookup_by_session("amplifier", "old-id").is_none(),
        "the legacy global wrapper cannot wildcard-match a scoped owner"
    );
    assert!(!ledger.ever_bound("amplifier", "old-id"));

    ledger.retire_closed_owner(&new, 3).unwrap();
    let retired = ledger.load_binding_for_owner(&new).unwrap();
    assert_eq!(retired.state, freshell_ws::pane_ledger::RowState::Retired);
    assert_eq!(
        retired.retired_reason,
        Some(freshell_ws::pane_ledger::RetiredReason::Closed)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_cross_scope_supersession_persists_the_complete_successor_owner() {
    let dir = unique_ledger_dir("amplifier-cross-scope-supersession");
    let old = owner("amplifier", "same-id", Some("/normalized/project-a"));
    let new = owner("amplifier", "same-id", Some("/normalized/project-b"));
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    ledger
        .record_binding(&durable_write(
            &old,
            "terminal-1",
            Some("/raw/project-a"),
            MaterializationState::Observed,
            1,
        ))
        .unwrap();
    ledger
        .record_binding(&durable_write(
            &new,
            "terminal-1",
            Some("/raw/project-b"),
            MaterializationState::Observed,
            2,
        ))
        .unwrap();

    let predecessor = ledger.load_binding_for_owner(&old).unwrap();
    let successor_json = serde_json::to_value(predecessor.superseded_by).unwrap();
    assert_eq!(
        successor_json["providerScope"], "/normalized/project-b",
        "the durable link must retain the successor's provider scope"
    );
    let resolution = ledger.lookup_by_owner(&old).expect("cross-scope chain");
    assert!(resolution.corrected);
    assert_eq!(resolution.row.provider_scope, new.provider_scope);
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let resolution = reloaded
        .lookup_by_owner(&old)
        .expect("cross-scope chain survives reload");
    assert!(resolution.corrected);
    assert_eq!(resolution.row.provider_scope, new.provider_scope);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_legacy_scope_less_supersession_json_remains_compatible() {
    let dir = unique_ledger_dir("legacy-scope-less-supersession");
    let provider_dir = dir.join("bindings").join("codex");
    std::fs::create_dir_all(&provider_dir).unwrap();
    std::fs::write(
        provider_dir.join("old-id.json"),
        br#"{"ledgerVersion":1,"provider":"codex","sessionId":"old-id","materialization":"unknown","mode":"codex","createdAt":1,"updatedAt":2,"lastObservedAt":1,"state":"retired","retiredReason":"superseded","supersededBy":{"provider":"codex","sessionId":"new-id"}}"#,
    )
    .unwrap();
    std::fs::write(
        provider_dir.join("new-id.json"),
        br#"{"ledgerVersion":1,"provider":"codex","sessionId":"new-id","materialization":"unknown","mode":"codex","createdAt":2,"updatedAt":2,"lastObservedAt":2,"state":"bound"}"#,
    )
    .unwrap();

    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let resolution = ledger
        .lookup_by_session("codex", "old-id")
        .expect("legacy scope-less chain remains readable");
    assert!(resolution.corrected);
    assert_eq!(resolution.row.session_id, "new-id");
    let predecessor = ledger.load_binding("codex", "old-id").unwrap();
    let json = serde_json::to_value(predecessor).unwrap();
    assert!(
        json["supersededBy"].get("providerScope").is_none(),
        "backward-compatible global owners omit rather than serialize a null scope"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn pane_ledger_owner_digest_collision_or_corruption_is_never_overwritten() {
    let dir = unique_ledger_dir("owner-collision");
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    let owner_a = owner("amplifier", "same-id", Some("/scope/a"));
    let owner_b = owner("amplifier", "same-id", Some("/scope/b"));
    ledger
        .record_binding(&durable_write(
            &owner_b,
            "terminal-b",
            Some("/raw/b"),
            MaterializationState::Observed,
            1,
        ))
        .unwrap();
    let v2_dir = dir.join("bindings").join("v2");
    let b_bytes = std::fs::read(v2_dir.join(owner_v2_filename(&owner_b))).unwrap();
    let a_path = v2_dir.join(owner_v2_filename(&owner_a));
    std::fs::write(&a_path, &b_bytes).unwrap();
    drop(ledger);

    let reloaded = freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone()));
    assert!(reloaded.load_binding_for_owner(&owner_a).is_none());
    assert!(
        reloaded
            .record_binding(&durable_write(
                &owner_a,
                "terminal-a",
                Some("/raw/a"),
                MaterializationState::Observed,
                2,
            ))
            .is_err(),
        "a mismatched row at the digest path is collision/corruption"
    );
    assert_eq!(
        std::fs::read(&a_path).unwrap(),
        b_bytes,
        "collision/corruption evidence is never overwritten"
    );
    std::fs::remove_dir_all(&dir).ok();
}
