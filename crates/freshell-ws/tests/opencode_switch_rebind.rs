//! Opencode mid-session rebind via TUI-plugin signal files (the P5 crown).
//!
//! Structural copy of `claude_session_rebind.rs` (see its header for the
//! determinism rationale — the test drives `drain_and_rebind_opencode`
//! directly on a state handle instead of racing a spawned sweep timer),
//! with the opencode deltas: `--session` resume args, `ses_`-shaped ids,
//! an ENABLED pane ledger (row-level G3 supersede assertions), and nine
//! phases:
//!   1. mid-session rebind (A→B) + provider-correct meta.updated + ledger G3
//!   2. restart resumes the NEW id (argv `--session B`, never A)
//!   3. rapid D→E→D in one sweep window: last-write-wins, no flapping
//!   4. invalid-shape signal ignored but consumed
//!   5. A13 hijack refusal (target session live-owned elsewhere)
//!   6. no-signal regression (the `--pure`/plugin-missing story)
//!   7. dead-pane retired rebind (D1.3) + restore resumes the moved ref
//!   8. first-bind arbitration (D1.2's signal half) on a never-bound pane
//!   9. retention: a no-pane signal is RETAINED on disk across sweeps
//!
//! ONE test fn: the phases share server/env state (OPENCODE_CMD /
//! OPENCODE_ARGV_CAPTURE_PATH are process-wide) and the one-owner-forever
//! guards make session ids unreusable across panes — every successful-bind
//! phase gets FRESH ids.

#[cfg(unix)]
mod common;

#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio_tungstenite::tungstenite::Message as WsMessage;

// Opencode-shaped session ids (`ses_` + 26 alphanumerics). One-owner-forever:
// a session id ever bound to one pane — live OR retired — can never
// successfully bind a different pane (A13 + retired-inclusive A8), so every
// phase that expects a bind on a different pane gets FRESH ids.
#[cfg(unix)]
const A: &str = "ses_aaaaaaaaaaaaaaaaaaaaaaaaaa";
#[cfg(unix)]
const B: &str = "ses_bbbbbbbbbbbbbbbbbbbbbbbbbb";
#[cfg(unix)]
const C: &str = "ses_cccccccccccccccccccccccccc";
#[cfg(unix)]
const D: &str = "ses_dddddddddddddddddddddddddd";
#[cfg(unix)]
const E: &str = "ses_eeeeeeeeeeeeeeeeeeeeeeeeee";
#[cfg(unix)]
const F: &str = "ses_ffffffffffffffffffffffffff";
#[cfg(unix)]
const G: &str = "ses_gggggggggggggggggggggggggg";
#[cfg(unix)]
const H: &str = "ses_hhhhhhhhhhhhhhhhhhhhhhhhhh";
#[cfg(unix)]
const I: &str = "ses_iiiiiiiiiiiiiiiiiiiiiiiiii";

/// Fake opencode that records its argv (one token per line, atomically via
/// tmp+mv) to `$OPENCODE_ARGV_CAPTURE_PATH` before parking — the argv-capture
/// idiom copied from `codex_fork_rebind.rs` / `claude_session_rebind.rs`.
#[cfg(unix)]
fn write_fake_opencode_capture() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-opencode-rebind-capture-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$OPENCODE_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$OPENCODE_ARGV_CAPTURE_PATH.tmp\" \"$OPENCODE_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake opencode capture script");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

/// `sleeper_cli_spec`-style opencode spec with `env_var: Some("OPENCODE_CMD")`.
/// ONE delta from the claude sibling: the shared spec builder hardcodes
/// `resume_args: ["--resume", "{{sessionId}}"]` (`tests/common/mod.rs:65`),
/// but the REAL opencode manifest resumes with `--session`
/// (`crates/freshell-server/src/extensions.rs` OPENCODE_MANIFEST) — and
/// Phases 2/7 assert `--session` in the captured argv.
#[cfg(unix)]
fn opencode_capture_spec() -> freshell_platform::CliCommandSpec {
    let mut spec = common::sleeper_cli_spec("opencode");
    spec.env_var = Some("OPENCODE_CMD".to_string());
    spec.resume_args = Some(vec!["--session".to_string(), "{{sessionId}}".to_string()]);
    spec
}

/// Poll the capture file the fake writes until it appears, then return the
/// argv tokens (one per line). Copied from `codex_fork_rebind.rs`.
#[cfg(unix)]
fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return raw.lines().map(str::to_string).collect();
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "spawned opencode child never wrote its argv capture at {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Position of the adjacent `["--session", session_id]` pair in argv, if any.
#[cfg(unix)]
fn session_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "--session" && w[1] == session_id)
}

/// The registry's `resume_session_id` for a terminal (meta probe).
#[cfg(unix)]
fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// One plugin-shaped signal file (`<terminal_id>__<nonce>.json` with a
/// timestamp-first nonce — lexicographic order == emission order).
#[cfg(unix)]
fn write_opencode_signal(root: &std::path::Path, terminal_id: &str, seq: u64, session_id: &str) {
    std::fs::create_dir_all(root).unwrap();
    let name = format!("{terminal_id}__{seq:014}-000001-1.json");
    std::fs::write(
        root.join(name),
        format!(r#"{{"session_id":"{session_id}","source":"opencode-tui-plugin"}}"#),
    )
    .unwrap();
}

/// Send one raw client frame (the [`send_create`] transmit idiom, generalized
/// to any payload).
#[cfg(unix)]
async fn send_json(ws: &mut common::TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send raw client frame");
}

/// Scan WS text frames until `pred` matches (10 s budget, the
/// [`next_associated_frame`] deadline-poll loop generalized to an arbitrary
/// predicate), returning the matching frame; panic with `label` on timeout.
#[cfg(unix)]
async fn wait_for_frame(
    ws: &mut common::TestWs,
    label: &str,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting frame: {other:?}"),
        }
    }
    panic!("[{label}] no matching frame within 10s");
}

/// [`common::spawn_server_with_specs`], but ALSO returning the `WsState`
/// handle so the test can drive `drain_and_rebind_opencode` directly
/// (deterministic — no sweep-timer race), and with an ENABLED pane ledger
/// rooted at `ledger_root` (the claude template's `PaneLedger::disabled()`
/// stores nothing, so no ledger assertion could pass against it). Ledger
/// assertions go through `state.pane_ledger` — the SAME instance the server
/// writes through (a separately-constructed reader over the same dir loads
/// its read index once at construction and would never see later writes).
#[cfg(unix)]
async fn spawn_server_returning_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_root: std::path::PathBuf,
    opencode_data_home: Option<std::path::PathBuf>,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    freshell_ws::WsState,
) {
    use std::sync::Arc;
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = freshell_ws::WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            ledger_root,
        ))),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": false } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(cli_commands),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: opencode_data_home.map(|home| {
            Arc::new(freshell_sessions::opencode_locator::OpencodeLocator::new(
                home,
            ))
        }),
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry, state)
}

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (10 s budget), returning the parsed frame. Copied
/// from `claude_session_rebind.rs`.
#[cfg(unix)]
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 10s");
}

/// Scan WS text frames until a `terminal.meta.updated` upserting
/// `terminal_id` with `session_id` arrives (10 s budget), returning THAT
/// upsert record. The rebind fan-out pins `associated` FIRST, then
/// `meta.updated` — call this right after [`next_associated_frame`].
#[cfg(unix)]
async fn next_meta_updated_record(
    ws: &mut common::TestWs,
    terminal_id: &str,
    session_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.meta.updated" {
                        if let Some(record) = value["upsert"].as_array().and_then(|records| {
                            records
                                .iter()
                                .find(|r| {
                                    r["terminalId"] == terminal_id && r["sessionId"] == session_id
                                })
                                .cloned()
                        }) {
                            return record;
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => {
                panic!("[{label}] ws ended/errored/timed out awaiting meta.updated: {other:?}")
            }
        }
    }
    panic!("[{label}] no terminal.meta.updated upsert for {terminal_id}/{session_id} within 10s");
}

/// Scan WS text frames until `pred` matches or `window` elapses, returning
/// whether a matching frame arrived. Serves the absence proofs.
#[cfg(unix)]
async fn frame_seen_within(
    ws: &mut common::TestWs,
    window: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return true;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false, // stream ended, ws error, or timed out
        }
    }
    false
}

/// Send a `terminal.create` and await its `terminal.created`, returning the
/// full frame (multi-pane phases need distinct requestIds — the
/// create-dedupe folds a repeated id into the FIRST create's terminal).
#[cfg(unix)]
async fn send_create(ws: &mut common::TestWs, body: serde_json::Value) -> serde_json::Value {
    ws.send(WsMessage::Text(body.to_string()))
        .await
        .expect("send terminal.create");
    common::next_frame_of_type(ws, "terminal.created").await
}

/// A `terminal.create` body for a restore-shaped opencode pane bound to
/// `session_id` (exactly what a client that accepted an `associated` frame
/// persists and replays).
#[cfg(unix)]
fn restore_create_body(request_id: &str, session_id: &str) -> serde_json::Value {
    json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "opencode",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
        "sessionRef": { "provider": "opencode", "sessionId": session_id },
    })
}

/// Raw ledger row accessor + assertions for the G3 supersede shape: the OLD
/// session's row `Retired`/`Superseded` with `superseded_by` → the NEW
/// session, whose own row is `Bound`.
#[cfg(unix)]
fn assert_ledger_superseded(
    ledger: &freshell_ws::pane_ledger::PaneLedger,
    old_session_id: &str,
    new_session_id: &str,
    label: &str,
) {
    let old = ledger
        .load_binding("opencode", old_session_id)
        .unwrap_or_else(|| panic!("[{label}] ledger must hold a row for {old_session_id}"));
    assert_eq!(
        old.state,
        freshell_ws::pane_ledger::RowState::Retired,
        "[{label}] the superseded session's row must be Retired"
    );
    assert_eq!(
        old.retired_reason,
        Some(freshell_ws::pane_ledger::RetiredReason::Superseded),
        "[{label}] the superseded session's row must be retired as Superseded"
    );
    assert_eq!(
        old.superseded_by,
        Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: new_session_id.to_string(),
        }),
        "[{label}] the superseded row must link to the new session"
    );
    let new = ledger
        .load_binding("opencode", new_session_id)
        .unwrap_or_else(|| panic!("[{label}] ledger must hold a row for {new_session_id}"));
    assert_eq!(
        new.state,
        freshell_ws::pane_ledger::RowState::Bound,
        "[{label}] the new session's row must be Bound"
    );
}

/// Seed `<data_home>/opencode.db` with the real `session`/`project` schema
/// and one root + one child row — the same fixture shape as
/// `opencode_association.rs`'s `open_seed_db`/`insert_session` twins.
#[cfg(unix)]
fn seed_opencode_db_with_root_and_child(
    data_home: &std::path::Path,
    root_id: &str,
    child_id: &str,
) {
    std::fs::create_dir_all(data_home).unwrap();
    let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_id TEXT,
            slug TEXT NOT NULL,
            directory TEXT NOT NULL,
            title TEXT NOT NULL,
            version TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_archived INTEGER
         );",
    )
    .unwrap();
    let insert = |id: &str, parent_id: Option<&str>| {
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
            rusqlite::params![format!("proj-{id}"), "/proj"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session
                (id, project_id, parent_id, slug, directory, title, version,
                 time_created, time_updated, time_archived)
             VALUES (?1, ?2, ?3, ?1, '/proj', ?1, 'test', 100, 100, NULL)",
            rusqlite::params![id, format!("proj-{id}"), parent_id],
        )
        .unwrap();
    };
    insert(root_id, None);
    insert(child_id, Some(root_id));
}

/// Bounded poll of the identity registry until `is_subagent` reaches
/// `expected` (the file's deadline-poll idiom — never a fixed sleep).
#[cfg(unix)]
async fn wait_for_is_subagent(
    state: &freshell_ws::WsState,
    terminal_id: &str,
    expected: Option<bool>,
    label: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if state.identity.get(terminal_id).and_then(|i| i.is_subagent) == expected {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "[{label}] is_subagent for {terminal_id} never reached {expected:?} \
                 (current: {:?})",
                state.identity.get(terminal_id).and_then(|i| i.is_subagent)
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Bug 1b, hook site #3: a TUI session-switch signal INTO a child (subagent)
/// session must re-classify the pane's `is_subagent` to `Some(true)`, and a
/// switch back OUT to the root must CLEAR it to `Some(false)` — the
/// both-directions contract (a stale `true` must not keep hiding the pane).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tui_switch_signal_reclassifies_is_subagent_in_both_directions() {
    const ROOT: &str = "ses_switchroot";
    const CHILD: &str = "ses_switchchild";

    // Isolated opencode.db (root + child rows) that the state's locator
    // classifies against. NO OPENCODE_CMD/OPENCODE_ARGV_CAPTURE_PATH use:
    // the sleeper spec's env_var is None, so this test never races the
    // sibling test's process-wide env swaps.
    let data_home = tempfile::tempdir().expect("opencode data home");
    seed_opencode_db_with_root_and_child(data_home.path(), ROOT, CHILD);

    let signal_dir = tempfile::tempdir().expect("signal root");
    let signal_root = signal_dir.path().to_path_buf();
    let watcher = freshell_ws::opencode_signal::OpencodeSignalWatcher::new(signal_root.clone());

    let ledger_dir = tempfile::tempdir().expect("ledger root");
    let (url, registry, state) = spawn_server_returning_state(
        vec![common::sleeper_cli_spec("opencode")],
        ledger_dir.path().to_path_buf(),
        Some(data_home.path().to_path_buf()),
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // An opencode pane resuming the ROOT session. The create-path hook
    // (site #1) classifies it Some(false); waiting for that write also
    // removes any race with the rebind classifications below.
    let created = send_create(&mut ws, restore_create_body("req-oc-reclass-1", ROOT)).await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    wait_for_is_subagent(&state, &terminal_id, Some(false), "create/root-classified").await;

    // 1) signal a switch to the CHILD id -> flag becomes Some(true).
    write_opencode_signal(&signal_root, &terminal_id, 1, CHILD);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    wait_for_is_subagent(&state, &terminal_id, Some(true), "switch-to-child").await;
    assert_eq!(
        state.identity.get(&terminal_id).and_then(|i| i.is_subagent),
        Some(true)
    );

    // 2) signal a switch back to the ROOT id -> flag becomes Some(false)
    //    (the clearing direction — a stale true must not keep hiding the pane).
    write_opencode_signal(&signal_root, &terminal_id, 2, ROOT);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    wait_for_is_subagent(&state, &terminal_id, Some(false), "switch-back-to-root").await;
    assert_eq!(
        state.identity.get(&terminal_id).and_then(|i| i.is_subagent),
        Some(false)
    );

    registry.kill(&terminal_id);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tui_switch_signal_rebinds_and_restart_resumes_the_new_id() {
    // ---- env setup (single test fn: this binary owns process env) ----
    let capture_for = |phase: &str| {
        std::env::temp_dir().join(format!(
            "freshell-opencode-rebind-argv-{phase}-{}.txt",
            std::process::id()
        ))
    };
    // The capture fake dereferences $OPENCODE_ARGV_CAPTURE_PATH on EVERY
    // spawn, so the var is set before the first create too.
    let capture_bind = capture_for("bind");
    let _ = std::fs::remove_file(&capture_bind);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_bind);
    std::env::set_var(
        "OPENCODE_CMD",
        write_fake_opencode_capture().to_string_lossy().to_string(),
    );

    let signal_dir = tempfile::tempdir().expect("signal root");
    let signal_root = signal_dir.path().to_path_buf();
    let watcher = freshell_ws::opencode_signal::OpencodeSignalWatcher::new(signal_root.clone());

    let ledger_dir = tempfile::tempdir().expect("ledger root");
    let (url, registry, state) = spawn_server_returning_state(
        vec![opencode_capture_spec()],
        ledger_dir.path().to_path_buf(),
        None,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // ── Phase 1 — mid-session rebind: opencode pane bound to A, then the
    // TUI plugin reports B via a signal file.
    let created = send_create(&mut ws, restore_create_body("req-oc-rebind-1", A)).await;
    let tid1 = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(
        registry_resume_id(&registry, &tid1).as_deref(),
        Some(A),
        "phase1 precondition: pane 1 bound to A"
    );

    write_opencode_signal(&signal_root, &tid1, 1, B);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;

    let rebound = next_associated_frame(&mut ws, &tid1, "phase1/rebind").await;
    assert_eq!(
        rebound["sessionRef"],
        json!({ "provider": "opencode", "sessionId": B }),
        "rebind must move the pane to the plugin-reported id: {rebound}"
    );
    assert_eq!(
        rebound["previousSessionId"],
        json!(A),
        "rebind must carry previousSessionId == the superseded id: {rebound}"
    );
    // The FOLLOWING meta.updated must claim provider "opencode" — this pins
    // the codex_identity.rs:268 fix (it hardcoded "codex").
    let meta = next_meta_updated_record(&mut ws, &tid1, B, "phase1/meta").await;
    assert_eq!(
        meta["provider"],
        json!("opencode"),
        "the rebind meta.updated must carry the pane's real provider: {meta}"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid1).as_deref(),
        Some(B),
        "registry meta resume_session_id must follow the rebind"
    );
    // Ledger G3: new bound row first, then retire+link old.
    assert_ledger_superseded(&state.pane_ledger, A, B, "phase1/ledger");
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "the acted-on signal file must be deleted (act-then-delete)"
    );

    // ────── Phase 1b — stale-expectation input bounce (Node-parity frame,
    // server/ws-handler.ts:2902-2925; guard SCOPED to the opencode lane,
    // which this rebind is): an in-flight terminal.input still
    // carrying the OLD ref A after the A→B rebind is bounced with
    // SESSION_IDENTITY_MISMATCH echoing actualSessionRef=B and is NOT
    // delivered; a frame carrying the NEW ref B is delivered with no error.
    // (Non-opencode divergence never bounces — pinned by the in-module
    // test non_opencode_divergence_passes_through.)
    send_json(
        &mut ws,
        json!({
            "type": "terminal.input",
            "terminalId": tid1,
            "data": "stale-ref-keystroke",
            "expectedSessionRef": { "provider": "opencode", "sessionId": A },
        }),
    )
    .await;
    let bounce = wait_for_frame(&mut ws, "phase1b/mismatch", |v| {
        v["type"] == "error"
            && v["code"] == "SESSION_IDENTITY_MISMATCH"
            && v["terminalId"] == json!(tid1)
    })
    .await;
    assert_eq!(
        bounce["actualSessionRef"],
        json!({ "provider": "opencode", "sessionId": B }),
        "bounce must echo the canonical (post-rebind) ref: {bounce}"
    );
    assert_eq!(
        bounce["expectedSessionRef"],
        json!({ "provider": "opencode", "sessionId": A }),
        "bounce must echo the stale expectation: {bounce}"
    );

    send_json(
        &mut ws,
        json!({
            "type": "terminal.input",
            "terminalId": tid1,
            "data": "fresh-ref-keystroke\r",
            "expectedSessionRef": { "provider": "opencode", "sessionId": B },
        }),
    )
    .await;
    let bounced_again = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "error" && v["code"] == "SESSION_IDENTITY_MISMATCH"
    })
    .await;
    assert!(
        !bounced_again,
        "a matching expectedSessionRef must be delivered, not bounced"
    );

    // ── Phase 2 — the restart story: kill, then replay EXACTLY what a
    // client that accepted the rebind persists (sessionRef {opencode, B} +
    // restore:true). The respawned opencode must launch `--session B`.
    registry.kill(&tid1);
    let capture_respawn = capture_for("respawn");
    let _ = std::fs::remove_file(&capture_respawn);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_respawn);

    let restored = send_create(&mut ws, restore_create_body("req-oc-rebind-2", B)).await;
    let tid2 = restored["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let argv = wait_for_captured_argv(&capture_respawn);
    assert!(
        session_pair_position(&argv, B).is_some(),
        "respawned opencode argv must contain `--session {B}`: {argv:?}"
    );
    assert!(
        !argv.iter().any(|t| t == A),
        "respawned opencode argv must NOT reference the superseded id {A}: {argv:?}"
    );

    // ── Phase 3 — rapid D→E→D in ONE sweep window (fresh pane + fresh ids:
    // A and B are one-owner-forever spent by phases 1-2). Last-write-wins,
    // idempotent, no flapping: the first D signal is a same-id no-op, then
    // D→E and E→D land in sorted order.
    let capture_p3 = capture_for("pane3");
    let _ = std::fs::remove_file(&capture_p3);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_p3);
    let created3 = send_create(&mut ws, restore_create_body("req-oc-rebind-3", D)).await;
    let tid3 = created3["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    write_opencode_signal(&signal_root, &tid3, 10, D);
    write_opencode_signal(&signal_root, &tid3, 11, E);
    write_opencode_signal(&signal_root, &tid3, 12, D);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;

    let first = next_associated_frame(&mut ws, &tid3, "phase3/d-to-e").await;
    assert_eq!(
        first["sessionRef"],
        json!({ "provider": "opencode", "sessionId": E }),
        "the FIRST frame must be the D→E rebind (the same-id D signal is a \
         silent no-op): {first}"
    );
    assert_eq!(first["previousSessionId"], json!(D), "{first}");
    let second = next_associated_frame(&mut ws, &tid3, "phase3/e-to-d").await;
    assert_eq!(
        second["sessionRef"],
        json!({ "provider": "opencode", "sessionId": D }),
        "the SECOND frame must be the E→D rebind (last-write-wins): {second}"
    );
    assert_eq!(second["previousSessionId"], json!(E), "{second}");
    assert_eq!(
        registry_resume_id(&registry, &tid3).as_deref(),
        Some(D),
        "the final identity must equal the LAST signal's id"
    );
    assert_eq!(
        state
            .identity
            .get(&tid3)
            .and_then(|i| i.session_id)
            .as_deref(),
        Some(D),
        "identity registry must land on the LAST signal's id"
    );
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "all three acted-on signals must be consumed"
    );

    // ── Phase 4 — invalid shape ignored (but consumed): a body whose
    // session_id is not `ses_`-shaped is warn-logged as
    // `opencode_signal_rejected` and deleted by the watcher.
    std::fs::write(
        signal_root.join(format!("{tid3}__00000000000020-000001-1.json")),
        r#"{"session_id":"not-a-session"}"#,
    )
    .expect("write invalid signal file");
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == tid3.as_str()
    })
    .await;
    assert!(
        !moved,
        "an invalid-shape signal must never produce an associated frame"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid3).as_deref(),
        Some(D),
        "meta must be unchanged by an invalid-shape signal"
    );
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "the invalid signal file must still be consumed (single-shot junk)"
    );

    // ── Phase 5 — hijack (A13): a second live opencode pane owns C; a
    // forged signal for pane tid2 claiming C must be refused, both panes'
    // meta unchanged, file consumed.
    let capture_p5 = capture_for("pane5");
    let _ = std::fs::remove_file(&capture_p5);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_p5);
    let created5 = send_create(&mut ws, restore_create_body("req-oc-rebind-5", C)).await;
    let tid5 = created5["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    write_opencode_signal(&signal_root, &tid2, 30, C);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;

    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == tid2.as_str()
    })
    .await;
    assert!(
        !moved,
        "a signal claiming a live-owned session must never rebind the pane (A13)"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid2).as_deref(),
        Some(B),
        "pane tid2 must still be bound to B"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid5).as_deref(),
        Some(C),
        "pane tid5 must still own C"
    );
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "the refused signal file must still be consumed (deliberate refusal = acted)"
    );

    // ── Phase 6 — no-signal regression (the `--pure`/plugin-missing story):
    // with no signal files present, a drain is a total no-op — exactly what
    // plugin loss, `--pure`, a user-set OPENCODE_TUI_CONFIG, or the kill
    // switch produce.
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    let any_frame = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated"
    })
    .await;
    assert!(!any_frame, "no signal ⇒ no rebind, ever");
    assert_eq!(registry_resume_id(&registry, &tid2).as_deref(), Some(B));
    assert_eq!(registry_resume_id(&registry, &tid3).as_deref(), Some(D));
    assert_eq!(registry_resume_id(&registry, &tid5).as_deref(), Some(C));

    // ── Phase 7 — dead-pane retired rebind + retention (D1.3): the pane
    // dies AFTER the switch but BEFORE the sweep; the retained signal must
    // still move the persisted ref so a future restore resumes the NEW id.
    let capture_p7 = capture_for("pane7");
    let _ = std::fs::remove_file(&capture_p7);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_p7);
    let created7 = send_create(&mut ws, restore_create_body("req-oc-rebind-7", F)).await;
    let tid7 = created7["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    // Bare registry.kill — NOT a WS terminal.kill frame, which would ALSO
    // retire the ledger row as Closed and make the Superseded assertion
    // below unsatisfiable.
    registry.kill(&tid7);
    // Identity retirement on this path happens in the PTY on_exit hook,
    // asynchronously on the reader thread. WAIT for it — without this the
    // drain can race the hook and take the LIVE path (0) instead of the
    // retired path (0b), and every assertion below would pass without ever
    // exercising D1.3.
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if state.identity.get(&tid7).is_some_and(|i| i.retired) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("identity for {tid7} never retired after registry.kill");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    write_opencode_signal(&signal_root, &tid7, 40, G);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;

    let rebound7 = next_associated_frame(&mut ws, &tid7, "phase7/retired-rebind").await;
    assert_eq!(
        rebound7["sessionRef"],
        json!({ "provider": "opencode", "sessionId": G }),
        "the retired-pane rebind must move the persisted ref to G: {rebound7}"
    );
    assert_eq!(rebound7["previousSessionId"], json!(F), "{rebound7}");
    let identity7 = state.identity.get(&tid7).expect("identity row preserved");
    assert!(
        identity7.retired,
        "the identity row must STILL be retired after the ref move"
    );
    assert_eq!(
        identity7.session_id.as_deref(),
        Some(G),
        "the retired identity row must now carry G"
    );
    assert_ledger_superseded(&state.pane_ledger, F, G, "phase7/ledger");
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "the acted-on signal file must be deleted (act-then-delete)"
    );

    // Restore through the ref/restore flow the association produced (the
    // frozen client moves the persisted pane ref on `associated` by layout
    // presence, so restore now carries G): the relaunch must resume G,
    // never F.
    let capture_p7b = capture_for("pane7-restore");
    let _ = std::fs::remove_file(&capture_p7b);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_p7b);
    let restored7 = send_create(&mut ws, restore_create_body("req-oc-rebind-8", G)).await;
    let tid7b = restored7["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let argv = wait_for_captured_argv(&capture_p7b);
    assert!(
        session_pair_position(&argv, G).is_some(),
        "restored opencode argv must contain `--session {G}`: {argv:?}"
    );
    assert!(
        !argv.iter().any(|t| t == F),
        "restored opencode argv must NOT reference the superseded id {F}: {argv:?}"
    );

    // ── Phase 8 — first-bind arbitration (D1.2's signal half): a live
    // opencode pane with NO session binding yet; the signal binds it (FRESH
    // id H — phase 5's pane stays alive and live-owns C, so a C signal
    // would be A13-refused).
    let capture_p8 = capture_for("pane8");
    let _ = std::fs::remove_file(&capture_p8);
    std::env::set_var("OPENCODE_ARGV_CAPTURE_PATH", &capture_p8);
    let created8 = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-oc-rebind-9",
            "mode": "opencode",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid8 = created8["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(
        registry_resume_id(&registry, &tid8),
        None,
        "phase8 precondition: a fresh opencode pane is never-bound"
    );

    write_opencode_signal(&signal_root, &tid8, 50, H);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;

    let bound8 = next_associated_frame(&mut ws, &tid8, "phase8/first-bind").await;
    assert_eq!(
        bound8["sessionRef"],
        json!({ "provider": "opencode", "sessionId": H }),
        "the first bind must attach H: {bound8}"
    );
    assert!(
        bound8["previousSessionId"].is_null(),
        "a first bind has no previous session: {bound8}"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid8).as_deref(),
        Some(H),
        "registry meta resume_session_id must follow the first bind"
    );
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "the acted-on signal file must be deleted (act-then-delete)"
    );

    // ── Phase 9 — retention: a signal naming a NONEXISTENT pane is not
    // actionable — the ladder returns false and the file is RETAINED on
    // disk for later sweeps (the RETAIN branch of act-then-delete, D1.1),
    // stably across repeated drains, and never emits an associated frame.
    let retained_tid = "no-such-pane-retention";
    write_opencode_signal(&signal_root, retained_tid, 60, I);
    let retained_path = signal_root.join(format!("{retained_tid}__{:014}-000001-1.json", 60));
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        retained_path.exists(),
        "a no-pane signal must be RETAINED on disk, not deleted (act-then-delete)"
    );
    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == retained_tid
    })
    .await;
    assert!(
        !moved,
        "a no-pane signal must never produce an associated frame"
    );
    // Retention is stable across sweeps, not a one-drain artifact.
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        retained_path.exists(),
        "the retained signal must survive a SECOND drain (stable retention)"
    );
    // Leave the signal dir empty, as every acted-on phase asserts.
    std::fs::remove_file(&retained_path).expect("clean up the retained signal");

    // ---- Phase 10: a signal addressed to a FOREIGN-provider pane is
    // explicitly ignored (logged) and CONSUMED -- it can never become
    // actionable (a pane's mode never changes), so retaining it would just
    // re-reject it silently every sweep for 10 minutes (unbounded noise).
    let created_foreign = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-oc-rebind-10",
            "mode": "shell",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid_foreign = created_foreign["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    write_opencode_signal(&signal_root, &tid_foreign, 10, "ses_foreignclaim0001");
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&state, &watcher).await;
    // The pane was not touched...
    assert!(
        !frame_seen_within(&mut ws, std::time::Duration::from_secs(2), |v| {
            v["type"] == "terminal.session.associated" && v["terminalId"] == tid_foreign.as_str()
        })
        .await,
        "a foreign-provider pane must never be rebound by an opencode signal"
    );
    // ...and the file was consumed, not silently retained.
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "foreign-provider signal files must be consumed (bounded), not retained"
    );

    registry.kill(&tid_foreign);
    registry.kill(&tid2);
    registry.kill(&tid3);
    registry.kill(&tid5);
    registry.kill(&tid7b);
    registry.kill(&tid8);
    std::env::remove_var("OPENCODE_ARGV_CAPTURE_PATH");
    std::env::remove_var("OPENCODE_CMD");
}
