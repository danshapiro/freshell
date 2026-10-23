//! How a freshclaude session ends when nobody asked it to (design §5.7 and §11.3
//! of docs/plans/2026-10-22-freshclaude-core-runtime.md; G02, G23). Every case runs
//! the REAL claude sidecar over the CLI simulator (RealSidecarSim,
//! `common::claude_rig`).
//!
//! The sidecar hosts one session, so when that session's SDK stream ends it reports
//! the end (`sdk.stream.ended`) and exits; the server's end-of-output path then ends
//! the session: one `freshAgent.error{SIDECAR_EXITED}` carrying the cause, exactly
//! one attention edge when a turn was running, and no live session left behind.
//! A Node death reports nothing, so the server rings for it itself.
//!
//! An ended session is not forgotten (C09, G05): it reports `status: exited`, the
//! server keeps a dead-session record so its snapshot says `exited` (from live
//! state), and a send to it is refused visibly instead of vanishing.
//!
//! A session starts only once its CLI booted (C10): the sidecar answers `created`
//! after the boot, so a boot the CLI refuses is a typed `freshAgent.create.failed`,
//! never a `freshAgent.created` for a session that is already dead, and a resume's
//! `created` names the resumed conversation in `sessionRef`.
//!
//! Unix only: the tests read the sidecar's pid and signal it (rust-gate runs on Linux).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use serde_json::{json, Value};

/// How long a test keeps reading after the exit report before it counts edges: the
/// server sends any edge of its own right after the report, so a second edge would
/// arrive well inside this window.
const QUIET: Duration = Duration::from_millis(500);

async fn rig_with_program(rules: Value) -> ClaudeRig {
    let program = json!({ "rules": rules }).to_string();
    ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)]).await
}

/// The pid of the sidecar process: the simulator runs inside it and stamps every
/// ledger row with its host's pid.
async fn sidecar_pid(rig: &ClaudeRig) -> i32 {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        if let Some(row) = rig.ledger_rows("boot").first() {
            return row["pid"].as_i64().expect("the boot row carries a pid") as i32;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the simulated CLI never booted"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether a process with this pid still exists (a zombie counts: it is not gone).
fn process_exists(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for the process; nothing is sent.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn wait_until_gone(pid: i32) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while process_exists(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the sidecar process {pid} is still there"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_sidecar_exited(conn: &mut RigConnection, session_id: &str) -> Value {
    let frame = conn
        .wait_for("freshAgent.error{SIDECAR_EXITED}", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.error"
                && v["event"]["code"] == "SIDECAR_EXITED"
        })
        .await;
    assert_eq!(frame["sessionId"], session_id, "{frame}");
    assert_eq!(frame["event"]["sessionId"], session_id, "{frame}");
    frame["event"].clone()
}

/// The durable id the session's first turn reported (`freshAgent.session.init`).
fn durable_id(conn: &RigConnection, session_id: &str) -> String {
    conn.frames
        .iter()
        .find_map(|v| {
            (v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.session.init"
                && v["event"]["sessionId"] == session_id)
                .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
                .flatten()
        })
        .expect("the session reported its durable id")
}

/// The statuses broadcast for the session, in order.
fn statuses(conn: &RigConnection, session_id: &str) -> Vec<String> {
    conn.frames
        .iter()
        .filter(|v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.status"
                && v["sessionId"] == session_id
        })
        .filter_map(|v| v["event"]["status"].as_str().map(str::to_string))
        .collect()
}

/// The CLI dies mid-turn (SIGKILL, T14): one attention edge for the lost turn, one
/// SIDECAR_EXITED naming the CLI's death, and the sidecar process is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cli_crash_mid_turn_rings_once_and_reports_the_cause() {
    let rig = rig_with_program(json!([{ "on": "msg:prompt", "emit": [
        { "kind": "text", "data": { "text": "partial" } },
        { "kind": "crash" },
    ] }]))
    .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn the CLI dies in")
        .await;
    let pid = sidecar_pid(&rig).await;

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(
        exited["cause"],
        json!({ "reason": "cli_exited", "message": "Claude Code process terminated by signal SIGKILL" }),
        "{exited}"
    );
    assert!(
        exited["message"].as_str().is_some_and(
            |message| message.contains("Claude Code process terminated by signal SIGKILL")
        ),
        "the banner says what happened: {exited}"
    );
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "exactly one edge for the lost turn; frames: {:?}",
        conn.frames
    );
    assert_eq!(
        conn.events_seen("freshAgent.result"),
        0,
        "{:?}",
        conn.frames
    );
    assert_eq!(
        conn.frames
            .iter()
            .filter(|v| v["event"]["code"] == "SIDECAR_EXITED")
            .count(),
        1,
        "one exit report; frames: {:?}",
        conn.frames
    );
}

/// The CLI ends the stream cleanly in the middle of the session's second turn (it
/// exits 0, so the SDK's iterator just ends). The earlier turn's result must not
/// leave the session busy (G23): the session ends, its last status is `exited`
/// (not busy), and the server no longer holds it as live.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_natural_end_of_stream_mid_turn_leaves_the_session_not_busy() {
    let rig = rig_with_program(
        json!([{ "on": "msg:prompt", "match": { "text": "second" }, "emit": [
        { "kind": "text", "data": { "text": "partial" } },
        { "kind": "crash", "data": { "code": 0 } },
    ] }]),
    )
    .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "first").await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    assert!(rig.fresh_claude.has_live_session(&durable).await);
    let pid = sidecar_pid(&rig).await;

    conn.send_text(&session_id, "send-2", "second").await;
    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "stream_eof", "{exited}");
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        statuses(&conn, &session_id).last().map(String::as_str),
        Some("exited"),
        "the session's last status is exited; frames: {:?}",
        conn.frames
    );
    assert!(
        !rig.fresh_claude.has_live_session(&durable).await,
        "the ended session is not held as live (and so cannot stay busy)"
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        2,
        "one edge per turn; frames: {:?}",
        conn.frames
    );
}

/// The Node sidecar itself is killed mid-turn: it reports nothing, so the server
/// rings for the lost turn itself, once, and names the signal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_node_death_mid_turn_rings_once() {
    let rig = rig_with_program(json!([{ "on": "msg:prompt", "emit": [{ "kind": "hang" }] }])).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn that never ends")
        .await;
    conn.wait_for_event("freshAgent.session.init").await;
    let pid = sidecar_pid(&rig).await;
    sigkill(pid);

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "sidecar_exited", "{exited}");
    assert_eq!(exited["cause"]["signal"], "SIGKILL", "{exited}");
    wait_until_gone(pid).await;

    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "exactly one edge for the lost turn; frames: {:?}",
        conn.frames
    );
}

/// An idle session whose CLI dies ends with the exit report, status `exited`, and
/// no edge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_cli_death_reports_the_exit_without_an_edge() {
    let rig =
        rig_with_program(json!([{ "on": "start", "emit": [{ "kind": "crash", "delayMs": 300 }] }]))
            .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["reason"], "cli_exited", "{exited}");
    conn.read_for(QUIET).await;
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        0,
        "{:?}",
        conn.frames
    );
    // The server announces the new session idle (C17), and it ends exited:
    // never running or compacting.
    assert_eq!(
        statuses(&conn, &session_id),
        vec!["idle".to_string(), "exited".to_string()],
        "an idle session that ends reports exited; frames: {:?}",
        conn.frames
    );
}

/// Kill the rig's sidecar process (the simulator runs inside it).
fn sigkill(pid: i32) {
    // SAFETY: the pid is this rig's own sidecar, read from its simulator's ledger.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
}

/// The Node sidecar is killed while a `/compact` runs (G05: an out-of-memory kill
/// mid-compaction). The pane must not stay `compacting` (busy) forever: the session
/// reports `exited`, the lost compaction rings exactly once, and the snapshot
/// overlay, read from the server's live state, says `exited` too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sidecar_death_mid_compact_ends_exited_with_one_ring_and_an_exited_snapshot() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "something to compact")
        .await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    let pid = sidecar_pid(&rig).await;

    // `/compact HANG`: the simulated compaction never finishes on its own.
    conn.send(json!({
        "type": "freshAgent.compact",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "compact-1",
        "instructions": "HANG",
    }))
    .await;
    conn.wait_for("freshAgent.status{compacting}", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.status"
            && v["event"]["status"] == "compacting"
    })
    .await;
    let edges_before = conn.events_seen("freshAgent.turn.complete");
    sigkill(pid);

    let exited = wait_for_sidecar_exited(&mut conn, &session_id).await;
    assert_eq!(exited["cause"]["signal"], "SIGKILL", "{exited}");
    wait_until_gone(pid).await;
    conn.read_for(QUIET).await;

    assert_eq!(
        statuses(&conn, &session_id).last().map(String::as_str),
        Some("exited"),
        "exited replaces compacting; frames: {:?}",
        conn.frames
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete") - edges_before,
        1,
        "the lost compaction rings exactly once; frames: {:?}",
        conn.frames
    );
    assert!(!rig.fresh_claude.has_live_session(&durable).await);
    for id in [&durable, &session_id] {
        let overlay = rig.fresh_claude.live_snapshot_overlay(id).await;
        assert_eq!(overlay["status"], "exited", "snapshot for {id}: {overlay}");
        assert_eq!(
            overlay["extensions"]["claude"]["statusFromLiveState"], true,
            "the exited status is live state, not a guess: {overlay}"
        );
    }
}

/// An ended conversation with a cleanly missing transcript is refused visibly:
/// nested INVALID_SESSION_ID and the correlated unsent prompt, with no fresh
/// replacement conversation. Resolvable crashes are covered by the recovery suite.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_to_a_dead_session_with_a_missing_transcript_gets_lost_and_a_request_error() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "first").await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    rig.wait_for_genesis_cleared(&durable).await;
    let projects = rig.claude_config_dir.join("projects");
    std::fs::rename(
        &projects,
        rig.claude_config_dir.with_extension("projects-saved"),
    )
    .unwrap();
    let pid = sidecar_pid(&rig).await;
    sigkill(pid);
    wait_for_sidecar_exited(&mut conn, &session_id).await;
    wait_until_gone(pid).await;
    assert!(
        !rig.fresh_claude.has_live_session(&durable).await,
        "a dead session is not live"
    );

    for (id, request_id) in [(session_id.clone(), "send-2"), (durable.clone(), "send-3")] {
        conn.send_text(&id, request_id, "after the death").await;
        let lost = conn
            .wait_for(&format!("the lost frame for {id}"), |v| {
                v["type"] == "freshAgent.event"
                    && v["event"]["type"] == "freshAgent.error"
                    && v["event"]["code"] == "INVALID_SESSION_ID"
                    && v["sessionId"] == id.as_str()
            })
            .await;
        assert_eq!(lost["event"]["sessionId"], id.as_str(), "{lost}");
        assert_eq!(lost["sessionType"], "freshclaude", "{lost}");
        let error = conn
            .wait_for(&format!("the request error for {request_id}"), |v| {
                v["type"] == "error" && v["requestId"] == request_id
            })
            .await;
        assert_eq!(error["code"], "INVALID_SESSION_ID", "{error}");
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| message.contains("could not be found")),
            "the error says why: {error}"
        );
    }
    conn.read_for(QUIET).await;
    assert!(
        !conn
            .frames
            .iter()
            .any(|v| v["type"] == "freshAgent.send.accepted"
                && matches!(v["requestId"].as_str(), Some("send-2" | "send-3"))),
        "no send after the death was accepted; frames: {:?}",
        conn.frames
    );
}

// ── Boot (C10): `created` only after the CLI booted; typed boot failures ──────────

/// The pid of the sidecar process of the `n`th query() the simulator ran in this rig
/// (1-based; every query() writes a `query` row, booted or not).
async fn query_pid(rig: &ClaudeRig, n: usize) -> i32 {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        if let Some(row) = rig.ledger_rows("query").get(n - 1) {
            return row["pid"].as_i64().expect("the query row carries a pid") as i32;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the sidecar never made query() #{n}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The create frame's field that resumes `durable`, as the client sends it.
fn resume_fields(durable: &str) -> Value {
    json!({ "sessionRef": { "provider": "claude", "sessionId": durable } })
}

/// A resume create of a conversation the CLI does not have is refused at create
/// (T5): one typed `freshAgent.create.failed` with the CLI's own sentence, never a
/// `freshAgent.created` for a session that is already dead, and no sidecar is left
/// behind. On both rigs: the simulator, and the pinned CLI itself.
async fn a_resume_create_of_a_missing_conversation_fails_typed(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let missing = uuid::Uuid::new_v4().to_string();

    let answer = conn
        .request_create("create-missing", resume_fields(&missing))
        .await;
    assert_eq!(answer["type"], "freshAgent.create.failed", "{answer}");
    assert_eq!(answer["code"], "CONVERSATION_NOT_FOUND", "{answer}");
    assert_eq!(
        answer["message"],
        format!("No conversation found with session ID: {missing}"),
        "{answer}"
    );
    if kind == RigKind::Sim {
        wait_until_gone(query_pid(&rig, 1).await).await;
    }

    conn.read_for(QUIET).await;
    assert!(
        !conn
            .frames
            .iter()
            .any(|v| v["type"] == "freshAgent.created" || v["type"] == "freshAgent.event"),
        "nothing of the refused boot reaches the client; frames: {:?}",
        conn.frames
    );
    assert!(!rig.fresh_claude.has_live_session(&missing).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resume_create_of_a_missing_conversation_fails_typed_and_leaves_no_sidecar() {
    a_resume_create_of_a_missing_conversation_fails_typed(RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resume_create_of_a_missing_conversation_fails_typed_on_the_pinned_cli() {
    a_resume_create_of_a_missing_conversation_fails_typed(RigKind::Cli).await;
}

/// A CLAUDE_CMD that is not the CLI fails the create (the pinned SDK cannot spawn
/// it, so no request is ever made): a typed `freshAgent.create.failed` naming the
/// path, not a `freshAgent.created` followed by the session's death.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_claude_cmd_that_is_not_the_cli_fails_the_create_typed() {
    let rig =
        ClaudeRig::start_with_env(RigKind::Cli, &[("CLAUDE_CMD", "/nonexistent/claude")]).await;
    let mut conn = rig.connect().await;

    let answer = conn.request_create("create-bad-cmd", json!({})).await;
    assert_eq!(answer["type"], "freshAgent.create.failed", "{answer}");
    assert_eq!(answer["code"], "BOOT_FAILED", "{answer}");
    assert!(
        answer["message"]
            .as_str()
            .is_some_and(|message| message.contains("/nonexistent/claude")),
        "the failure names the command: {answer}"
    );
    conn.read_for(QUIET).await;
    assert!(
        !conn
            .frames
            .iter()
            .any(|v| v["type"] == "freshAgent.created" || v["type"] == "freshAgent.event"),
        "frames: {:?}",
        conn.frames
    );
}

/// A resume create is answered only once the CLI booted the conversation (no prompt
/// needed, T2), and `freshAgent.created` names the resumed conversation in
/// `sessionRef`, so a caller learns the native identity without waiting for a turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resume_create_answers_created_with_its_session_ref_once_the_cli_booted() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn to resume")
        .await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    rig.wait_for_transcripts().await;
    conn.kill(&session_id).await;

    let answer = conn
        .request_create("create-resume", resume_fields(&durable))
        .await;
    assert_eq!(answer["type"], "freshAgent.created", "{answer}");
    // The simulated CLI records its boot before initializationResult() resolves.
    let boots = rig.ledger_rows("boot");
    assert_eq!(
        boots.len(),
        2,
        "the resumed CLI booted before created: {boots:?}"
    );
    assert_eq!(boots[1]["sessionId"], durable.as_str(), "{boots:?}");
    assert_eq!(
        answer["sessionRef"],
        json!({ "provider": "claude", "sessionId": durable }),
        "{answer}"
    );
    assert!(rig.ledger_rows("prompt").len() == 1, "no prompt was needed");
}

// ── Registration: a session is in the map before its consumer reads a line ────────

/// How long the server is made to take between starting a session's consumer and
/// registering the session (the production resume create awaits an identity-sink
/// write there; the rig has no sink). Longer than the sidecar takes to write the
/// boot catalog, or a CLI death 300 ms after its boot, so both land inside it.
const REGISTRATION_HOLD: Duration = Duration::from_millis(1500);

/// The session's snapshot overlay once `ready` holds for it (bounded wait).
async fn overlay_once(rig: &ClaudeRig, id: &str, ready: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let overlay = rig.fresh_claude.live_snapshot_overlay(id).await;
        if ready(&overlay) {
            return overlay;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the snapshot overlay of {id} never got there: {overlay}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The command catalog the sidecar publishes right after `created` reaches the
/// session's live state (its snapshot's `commands`) with no turn sent, for a fresh
/// and for a resume create, however long the server takes to register the session.
/// A consumer that read the catalog line before its session was registered dropped
/// it, and the slash menu then had only the built-in entries (review PRB-C10).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_boot_catalog_reaches_the_live_state_however_long_the_registration_takes() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "a turn to resume")
        .await;
    conn.wait_for_event("freshAgent.turn.complete").await;
    let durable = durable_id(&conn, &session_id);
    rig.wait_for_transcripts().await;
    conn.kill(&session_id).await;

    rig.fresh_claude
        .hold_session_registration(REGISTRATION_HOLD);
    for (request_id, extra) in [
        ("create-fresh", json!({})),
        ("create-resume", resume_fields(&durable)),
    ] {
        let answer = conn.request_create(request_id, extra).await;
        assert_eq!(answer["type"], "freshAgent.created", "{answer}");
        let id = answer["sessionId"].as_str().expect("created carries an id");
        let overlay = overlay_once(&rig, id, |overlay| overlay["commands"].is_array()).await;
        assert!(
            overlay["commands"]
                .as_array()
                .is_some_and(|commands| commands.iter().any(|c| c["name"] == "compact")),
            "{request_id}: {overlay}"
        );
    }
    assert_eq!(
        rig.ledger_rows("prompt").len(),
        1,
        "no turn was sent after the first"
    );
}

/// A CLI that dies right after it booted, while the server is still registering
/// the session, still ends the session: the exit report arrives and the session
/// reads as exited, never as a live session nobody will ever end (review PRB-C10).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cli_death_during_registration_refuses_create_and_leaves_no_runtime() {
    let rig =
        rig_with_program(json!([{ "on": "start", "emit": [{ "kind": "crash", "delayMs": 300 }] }]))
            .await;
    rig.fresh_claude
        .hold_session_registration(REGISTRATION_HOLD);
    let mut conn = rig.connect().await;
    let refused = conn.request_create("create-1", json!({})).await;
    assert_eq!(refused["type"], "freshAgent.create.failed", "{refused}");
    assert_eq!(refused["code"], "FRESH_AGENT_CREATE_FAILED", "{refused}");
    let boot = rig
        .ledger_rows("boot")
        .into_iter()
        .next()
        .expect("the CLI booted before crashing");
    let session_id = boot["sessionId"].as_str().unwrap();
    // Creation failed before a runtime was acknowledged; its failure is the
    // client-visible outcome. Confirm cleanup directly for both child pids.
    assert!(!rig.fresh_claude.has_live_session(session_id).await);
    for pid in rig.runtime_pids(session_id) {
        wait_until_gone(pid as i32).await;
    }
    conn.read_for(QUIET).await;
    assert!(
        !conn
            .frames
            .iter()
            .any(|frame| frame["type"] == "freshAgent.created" && frame["requestId"] == "create-1"),
        "{:#?}",
        conn.frames
    );
}
