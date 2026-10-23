//! Undo and redo for freshclaude through a boot-verified fork runtime (core
//! design §4.5 and §4.6, C13; audit G01).
//!
//! Every test runs the REAL claude sidecar over the CLI simulator
//! (RealSidecarSim), with a real pane ledger and the ownership coordinator wired
//! the way main.rs wires them. The simulator boots like the pinned CLI: a
//! conversation boots with no prompt, `system/init` arrives only with a turn
//! (T1), and a lazy fork writes nothing until its first prompt (T6). The pre-C13
//! rollback waited for an init after the respawn, which the real CLI never sends
//! without a prompt, so on this rig every undo timed out (G01).
//!
//! An undo mints the replacement's id (C), boots the fork of the conversation's
//! effective transcript under C while the original (A) is still live, records
//! C's binding (genesis `Fork{A, at}` or `Fresh`, `supersedes: A`) with the
//! rollback record re-keyed to C, moves ownership A→C, and only then stops A.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use freshell_protocol::SessionType;

/// An undo answers within this budget. The pre-C13 rollback answered only after
/// its 45 s init wait expired.
const ROLLBACK_BUDGET: Duration = Duration::from_secs(20);

async fn rollback_rig() -> ClaudeRig {
    ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await
}

fn ledger(rig: &ClaudeRig) -> &freshell_ws::pane_ledger::PaneLedger {
    rig.pane_ledger.as_deref().expect("the rig has a ledger")
}

/// One finished turn per prompt (each `freshAgent.result`), each on disk before
/// the next: the CLI flushes a transcript line 95-200 ms after its SDK frame
/// (T3), and an undo reads the transcript.
async fn converse(rig: &ClaudeRig, conn: &mut RigConnection, session_id: &str, prompts: &[&str]) {
    for (n, prompt) in prompts.iter().enumerate() {
        let results_before = conn.events_seen("freshAgent.result");
        conn.send_text(session_id, &format!("send-{session_id}-{n}"), prompt)
            .await;
        wait_for_results(conn, results_before + 1, prompt).await;
        let path = rig
            .wait_for_transcript(&conn.init_session_id(session_id))
            .await;
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            let lines = chain_lines(&path);
            let at = lines.iter().rposition(|line| {
                line["type"] == "user" && line["message"]["content"][0]["text"] == *prompt
            });
            if at.is_some_and(|at| lines[at..].iter().any(|line| line["type"] == "assistant")) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the turn for {prompt:?} never reached disk"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

async fn wait_for_results(conn: &mut RigConnection, count: usize, what: &str) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while conn.events_seen("freshAgent.result") < count {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the turn for {what:?} never finished; frames: {:?}",
            conn.frames
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

/// `freshAgent.undo` / `freshAgent.redo` from the pane `pane_id`, fenced with the
/// owner pair the client holds for the session's durable id (the client sends it
/// with every rollback).
async fn request_rollback(
    conn: &mut RigConnection,
    kind: &str,
    pane_id: &str,
    durable: &str,
    request_id: &str,
    turn_id: Option<&str>,
) {
    let (epoch, generation) = conn
        .owner_pair(durable)
        .unwrap_or_else(|| panic!("an owner record for {durable} was broadcast"));
    let mut frame = json!({
        "type": format!("freshAgent.{kind}"),
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane_id,
        "requestId": request_id,
        "mode": if turn_id.is_some() { "toTurn" } else { "step" },
        "observedEpoch": epoch,
        "observedGeneration": generation,
    });
    if let Some(turn_id) = turn_id {
        frame["turnId"] = json!(turn_id);
    }
    conn.send(frame).await;
}

/// The requester's answer to rollback `request_id`: the ack (`rolledBack` /
/// `redone`) or the rollback error, within [`ROLLBACK_BUDGET`].
async fn rollback_answer(conn: &mut RigConnection, request_id: &str) -> Value {
    let started = tokio::time::Instant::now();
    let answer = tokio::time::timeout(
        ROLLBACK_BUDGET,
        conn.wait_for(&format!("the answer to rollback {request_id}"), |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["requestId"] == request_id
                && matches!(
                    v["event"]["type"].as_str(),
                    Some("freshAgent.rolledBack" | "freshAgent.redone" | "freshAgent.error")
                )
        }),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "rollback {request_id} was not answered within {ROLLBACK_BUDGET:?}; frames: {:?}",
            conn.frames
        )
    });
    eprintln!(
        "{}",
        json!({ "severity": "info", "event": "rollback_answered", "request": request_id,
                "ms": started.elapsed().as_millis() as u64 })
    );
    answer["event"].clone()
}

/// An undo or redo that must succeed: its ack, and the new session id it names.
async fn rollback_ok(
    conn: &mut RigConnection,
    kind: &str,
    pane_id: &str,
    durable: &str,
    request_id: &str,
) -> (Value, String) {
    request_rollback(conn, kind, pane_id, durable, request_id, None).await;
    let ack = rollback_answer(conn, request_id).await;
    let expected = if kind == "undo" {
        "freshAgent.rolledBack"
    } else {
        "freshAgent.redone"
    };
    assert_eq!(ack["type"], expected, "{ack}");
    let new_id = ack["newSessionId"]
        .as_str()
        .expect("the ack names the replacement session")
        .to_string();
    (ack, new_id)
}

/// The `freshAgent.session.materialized` frame that re-keyed `from`.
async fn materialized_from(conn: &mut RigConnection, from: &str) -> Value {
    conn.wait_for(&format!("materialized {from}"), |v| {
        v["type"] == "freshAgent.session.materialized" && v["previousSessionId"] == from
    })
    .await
}

/// The `query()` options the simulator recorded, in order.
fn queries(rig: &ClaudeRig) -> Vec<Value> {
    rig.ledger_rows("query")
        .into_iter()
        .map(|row| row["options"].clone())
        .collect()
}

/// The recorded `query()` options of the boot that ran under `session_id`.
fn boot_of(rig: &ClaudeRig, session_id: &str) -> Value {
    let matching: Vec<Value> = queries(rig)
        .into_iter()
        .filter(|o| o["sessionId"] == session_id)
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "one boot under {session_id}: {:?}",
        queries(rig)
    );
    matching.into_iter().next().unwrap()
}

/// The chain lines (those with a uuid) of a transcript, in file order.
fn chain_lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .expect("read the transcript")
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|line| line["uuid"].is_string())
        .collect()
}

fn uuid_where(lines: &[Value], what: &str, predicate: impl Fn(&Value) -> bool) -> String {
    lines
        .iter()
        .find(|line| predicate(line))
        .and_then(|line| line["uuid"].as_str())
        .unwrap_or_else(|| panic!("no transcript line for {what}"))
        .to_string()
}

fn prompt_uuid(lines: &[Value], text: &str) -> String {
    uuid_where(lines, text, |line| {
        line["type"] == "user" && line["message"]["content"][0]["text"] == text
    })
}

/// The uuid of the last chain line before the line `uuid`.
fn uuid_before(lines: &[Value], uuid: &str) -> String {
    let at = lines
        .iter()
        .position(|line| line["uuid"] == uuid)
        .expect("the line is in the transcript");
    lines[at - 1]["uuid"].as_str().expect("a uuid").to_string()
}

async fn snapshot_turn_ids(rig: &ClaudeRig, session_id: &str) -> Vec<String> {
    let snapshot = rig
        .fresh_claude
        .get_snapshot(SessionType::Freshclaude, session_id)
        .await
        .unwrap_or_else(|error| panic!("a snapshot of {session_id}: {error:?}"));
    snapshot["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter_map(|t| t["turnId"].as_str().map(str::to_string))
        .collect()
}

fn transcript_of(rig: &ClaudeRig, session_id: &str) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    rig.transcripts()
        .into_iter()
        .find(|path| path.file_name().and_then(|n| n.to_str()) == Some(name.as_str()))
}

fn assert_never_chimes(conn: &RigConnection) {
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        conn.events_seen("freshAgent.result"),
        "a rollback never rings: one edge per turn, none for the rollback"
    );
}

fn is_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

/// A two-turn conversation on a new pane: (pane id, durable id A, A's transcript).
async fn two_turns(rig: &ClaudeRig, conn: &mut RigConnection) -> (String, String, PathBuf) {
    let pane = conn.create("create-1").await;
    converse(rig, conn, &pane, &["first prompt", "second prompt"]).await;
    let durable = conn.init_session_id(&pane);
    let path = rig.wait_for_transcript(&durable).await;
    (pane, durable, path)
}

/// G01: the undo answers in time. The pane is re-keyed to the new id C (a UUID
/// minted by the server), the fork of A through the first answer booted under C
/// with the drops-turn guard on the undone prompt, C's binding records how C came
/// to be and supersedes A, the rollback record followed the pane, C's snapshot is
/// the kept prefix, A's transcript is untouched and A's runtime was stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_answers_in_time_with_a_fork_materialized_under_a_new_id() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let a_before = std::fs::read_to_string(&a_path).expect("read A");
    let lines = chain_lines(&a_path);
    let u2 = prompt_uuid(&lines, "second prompt");
    let keep = uuid_before(&lines, &u2);
    let a_runtime = rig.runtime_processes(&a);

    let (ack, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    assert_eq!(ack["removedPromptText"], "second prompt", "{ack}");
    assert_eq!(ack["canRedo"], true, "{ack}");
    assert!(is_uuid(&c) && c != a, "C is a new UUID: {c}");
    let removed: Vec<&str> = ack["removedTurnIds"]
        .as_array()
        .expect("removedTurnIds")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(removed.first().copied(), Some(u2.as_str()), "{ack}");

    let materialized = materialized_from(&mut conn, &pane).await;
    assert_eq!(materialized["sessionId"], c.as_str());
    assert_eq!(
        materialized["sessionRef"],
        json!({ "provider": "claude", "sessionId": c })
    );

    let boot = boot_of(&rig, &c);
    assert_eq!(boot["forkSession"], true, "{boot}");
    assert_eq!(boot["resume"], a.as_str(), "{boot}");
    assert_eq!(boot["resumeSessionAt"], keep.as_str(), "{boot}");
    assert_eq!(boot["resumeDropsTurn"], u2.as_str(), "{boot}");

    let row = ledger(&rig)
        .load_binding("claude", &c)
        .expect("C's binding");
    assert_eq!(
        row.genesis,
        Some(json!({ "kind": "fork", "parent": a, "at": keep, "dropsTurn": u2 }))
    );
    assert_eq!(row.cwd.as_deref(), rig.workspace.to_str());
    let superseded = ledger(&rig)
        .load_binding("claude", &a)
        .expect("A's binding");
    assert_eq!(
        superseded.superseded_by.map(|locator| locator.session_id),
        Some(c.clone()),
        "A's binding names C as its successor"
    );
    assert!(ledger(&rig).load_rollback_row("claude", &a).is_none());
    let record = ledger(&rig)
        .load_rollback_row("claude", &c)
        .expect("the rollback record followed the pane to C");
    assert_eq!(record["originalSessionId"], a.as_str());

    let c_turns = snapshot_turn_ids(&rig, &c).await;
    let a_turns = snapshot_turn_ids(&rig, &a).await;
    assert!(
        !c_turns.is_empty() && a_turns.starts_with(&c_turns) && !c_turns.contains(&u2),
        "C holds A's turns through the first answer: C {c_turns:?}, A {a_turns:?}"
    );
    assert_eq!(
        transcript_of(&rig, &c),
        None,
        "the fork writes nothing yet (T6)"
    );
    assert_eq!(std::fs::read_to_string(&a_path).expect("read A"), a_before);
    a_runtime.wait_until_exited("A's runtime").await;
    assert!(rig.fresh_claude.has_live_session(&c).await);
    assert_never_chimes(&conn);
}

/// The fork materializes at its first prompt: the CLI reports C as the session
/// (init), writes C's transcript with A's prefix (uuids kept) and the new turn,
/// and the genesis is cleared once that transcript is on disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_send_after_an_undo_writes_the_fork_under_its_id() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let a_before = std::fs::read_to_string(&a_path).expect("read A");
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    let prefix = snapshot_turn_ids(&rig, &c).await;

    converse(&rig, &mut conn, &c, &["a different second prompt"]).await;
    assert_eq!(conn.init_session_id(&c), c, "the CLI ran under C");
    let c_path = rig.wait_for_transcript(&c).await;
    rig.wait_for_genesis_cleared(&c).await;
    let c_lines = chain_lines(&c_path);
    let a_lines = chain_lines(&a_path);
    let kept = prefix.len();
    assert!(kept > 0);
    let materialized = snapshot_turn_ids(&rig, &c).await;
    assert!(
        materialized.starts_with(&prefix) && materialized.len() > prefix.len(),
        "the prefix leads C with the same turn ids: {prefix:?} then {materialized:?}"
    );
    assert!(c_lines
        .iter()
        .any(|line| line["message"]["content"][0]["text"] == "a different second prompt"));
    assert!(
        c_lines[0]["uuid"] == a_lines[0]["uuid"],
        "A's lines keep their uuids"
    );
    assert_eq!(std::fs::read_to_string(&a_path).expect("read A"), a_before);
    assert_never_chimes(&conn);
}

/// Redo re-forks the chain root (A) through the restored turn: the restored
/// session holds every turn again, and nothing beyond it is left to redo.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redo_restores_the_undone_turn() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let all_turns = snapshot_turn_ids(&rig, &a).await;
    let lines = chain_lines(&a_path);
    let tip = lines.last().expect("a tip")["uuid"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;

    let (ack, d) = rollback_ok(&mut conn, "redo", &c, &c, "redo-1").await;
    assert_eq!(ack["canRedo"], false, "{ack}");
    assert!(is_uuid(&d) && d != c && d != a, "{d}");
    materialized_from(&mut conn, &c).await;
    let boot = boot_of(&rig, &d);
    assert_eq!(boot["forkSession"], true, "{boot}");
    assert_eq!(
        boot["resume"],
        a.as_str(),
        "redo forks the chain root: {boot}"
    );
    assert_eq!(boot["resumeSessionAt"], tip.as_str(), "{boot}");
    assert_eq!(
        boot.get("resumeDropsTurn"),
        None,
        "nothing is discarded, so nothing is guarded: {boot}"
    );
    assert_eq!(snapshot_turn_ids(&rig, &d).await, all_turns);

    converse(&rig, &mut conn, &d, &["third prompt"]).await;
    assert_eq!(conn.init_session_id(&d), d);
    assert_never_chimes(&conn);
}

/// §4.5 source collapse: a second undo before any send forks the ORIGINAL at the
/// earlier point (chains never nest), so it boots although the first fork has no
/// transcript; it discards two of A's turns, so no single-turn guard is armed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_undo_before_any_send_forks_the_original_again() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(
        &rig,
        &mut conn,
        &pane,
        &["first prompt", "second prompt", "third prompt"],
    )
    .await;
    let a = conn.init_session_id(&pane);
    let a_path = rig.wait_for_transcript(&a).await;
    let lines = chain_lines(&a_path);
    let keep = uuid_before(&lines, &prompt_uuid(&lines, "second prompt"));

    let (_, c1) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    let (ack, c2) = rollback_ok(&mut conn, "undo", &c1, &c1, "undo-2").await;
    assert_eq!(ack["removedPromptText"], "second prompt", "{ack}");
    assert_eq!(ack["canRedo"], true, "{ack}");
    materialized_from(&mut conn, &c1).await;

    let boot = boot_of(&rig, &c2);
    assert_eq!(
        boot["resume"],
        a.as_str(),
        "the fork of a fork forks A: {boot}"
    );
    assert_eq!(boot["resumeSessionAt"], keep.as_str(), "{boot}");
    assert_eq!(
        boot.get("resumeDropsTurn"),
        None,
        "two turns discarded: {boot}"
    );
    assert_eq!(
        ledger(&rig)
            .load_binding("claude", &c2)
            .expect("C2's row")
            .genesis,
        Some(json!({ "kind": "fork", "parent": a, "at": keep }))
    );
    assert_eq!(transcript_of(&rig, &c1), None, "C1 never materialized");
    let c2_turns = snapshot_turn_ids(&rig, &c2).await;
    assert_eq!(c2_turns.len(), 2, "the first turn only: {c2_turns:?}");

    // Redo still reaches the root's later turns from the collapsed chain.
    let (_, d) = rollback_ok(&mut conn, "redo", &c2, &c2, "redo-1").await;
    materialized_from(&mut conn, &c2).await;
    assert_eq!(snapshot_turn_ids(&rig, &d).await.len(), 4);
    converse(&rig, &mut conn, &d, &["a new third prompt"]).await;
    assert_eq!(conn.init_session_id(&d), d);
}

/// First-turn undo (r2): the replacement is a FRESH conversation under C (no
/// resume, no fork); its snapshot is empty; a redo restores the turn from A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_the_only_turn_starts_a_fresh_conversation_and_redo_restores_it() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["only prompt"]).await;
    let a = conn.init_session_id(&pane);
    let a_turns = snapshot_turn_ids(&rig, &a).await;

    let (ack, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    assert_eq!(ack["removedPromptText"], "only prompt");
    materialized_from(&mut conn, &pane).await;
    let boot = boot_of(&rig, &c);
    assert_eq!(boot.get("resume"), None, "{boot}");
    assert_eq!(boot.get("forkSession"), None, "{boot}");
    assert_eq!(
        ledger(&rig)
            .load_binding("claude", &c)
            .expect("C's row")
            .genesis,
        Some(json!({ "kind": "fresh" }))
    );
    assert!(snapshot_turn_ids(&rig, &c).await.is_empty());

    let (_, d) = rollback_ok(&mut conn, "redo", &c, &c, "redo-1").await;
    materialized_from(&mut conn, &c).await;
    assert_eq!(snapshot_turn_ids(&rig, &d).await, a_turns);
    converse(&rig, &mut conn, &d, &["second prompt"]).await;
    assert_eq!(conn.init_session_id(&d), d);
}

/// Decision 2: Claude folded another message into the turn being undone (here a
/// background agent's completion notice, written into the launching turn, T19),
/// so the fork's drops-turn guard is refused at boot. The undo answers
/// ROLLBACK_REFUSED with a plain reason, is never retried without the guard,
/// writes no rollback record, and the original stays live and takes a send. (A
/// send absorbed during a tool call is refused the same way, below.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_of_a_turn_claude_folded_a_message_into_is_refused_and_the_session_stays_live() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-agent", "AGENT:async").await;
    // The launching turn's result, then the turn the agent's completion starts.
    wait_for_results(&mut conn, results + 2, "the background agent's turns").await;
    let a = conn.init_session_id(&pane);
    let a_path = rig.wait_for_transcript(&a).await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while !chain_lines(&a_path)
        .iter()
        .any(|line| line["origin"]["kind"] == "task-notification")
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no notification line"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let boots_before = queries(&rig).len();

    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    let refused = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(refused["type"], "freshAgent.error", "{refused}");
    assert_eq!(refused["code"], "ROLLBACK_REFUSED", "{refused}");
    assert_eq!(
        refused["message"],
        "Claude folded another message into that turn, so it can't be undone to that point."
    );
    let forks: Vec<Value> = queries(&rig).into_iter().skip(boots_before).collect();
    assert_eq!(
        forks.len(),
        1,
        "one guarded fork, never a guard-less retry: {forks:?}"
    );
    assert!(forks[0]["resumeDropsTurn"].is_string(), "{:?}", forks[0]);
    assert!(ledger(&rig).load_rollback_row("claude", &a).is_none());
    assert_eq!(
        ledger(&rig)
            .load_binding("claude", &a)
            .expect("A's row")
            .superseded_by,
        None
    );

    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-after", "still here?").await;
    wait_for_results(&mut conn, results + 1, "the send after the refusal").await;
    assert_eq!(
        conn.request_errors("send-after"),
        Vec::<Value>::new(),
        "A took the send"
    );
}

/// G08 at the rollback gate (C17: the gate reads the per-command ledger): a
/// send absorbed into a tool call (T10) is one of two commands the turn's one
/// result settles, so the session is idle afterwards and an undo reaches the
/// CLI instead of answering BUSY_TURN. The turn being undone absorbed the
/// second message, so the fork's drops-turn guard refuses it (decision 2):
/// ROLLBACK_REFUSED, one guarded boot and no guard-less retry, and the original
/// stays live and takes a send.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_of_a_turn_that_absorbed_a_send_is_refused_by_the_cli_not_busy() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-tool", "TOOL:sleep=2").await;
    conn.wait_for("the tool call", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.assistant"
            && v["event"]["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_use"))
    })
    .await;
    conn.send_text(&pane, "send-absorbed", "and one more thing")
        .await;
    wait_for_results(&mut conn, results + 1, "the absorbing turn").await;
    let a = conn.init_session_id(&pane);
    let a_path = rig.wait_for_transcript(&a).await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while !chain_lines(&a_path)
        .iter()
        .any(|line| line["type"] == "attachment" && line["attachment"]["type"] == "queued_command")
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the absorbed send never reached disk"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while rig.fresh_claude.session_busy(&pane).await != Some(false) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the absorbed send left the session busy"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let boots_before = queries(&rig).len();

    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    let refused = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(refused["type"], "freshAgent.error", "{refused}");
    assert_eq!(refused["code"], "ROLLBACK_REFUSED", "{refused}");
    let forks: Vec<Value> = queries(&rig).into_iter().skip(boots_before).collect();
    assert_eq!(
        forks.len(),
        1,
        "one guarded fork, never a guard-less retry: {forks:?}"
    );
    assert!(forks[0]["resumeDropsTurn"].is_string(), "{:?}", forks[0]);
    assert!(ledger(&rig).load_rollback_row("claude", &a).is_none());

    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-after", "still here?").await;
    wait_for_results(&mut conn, results + 1, "the send after the refusal").await;
    assert_eq!(
        conn.request_errors("send-after"),
        Vec::<Value>::new(),
        "A took the send"
    );
}

/// The rollback gate's recheck (C17): the gate admitted an undo while the
/// session was idle, but a background agent finished while the undo read the
/// transcript, and its completion started a turn the CLI runs by itself (T19).
/// The ledger is busy again when the undo would boot its replacement, so the
/// undo answers BUSY_TURN, boots nothing and leaves no rollback record, and the
/// CLI's own turn finishes on the original.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_refuses_when_the_cli_starts_a_turn_of_its_own_after_the_gate() {
    // A slower clock gives the undo seconds to reach its hold before the
    // background agent finishes.
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            env: vec![("FRESHELL_CLAUDE_SIM_TIME_SCALE".into(), "3".into())],
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-agent", "AGENT:async").await;
    wait_for_results(&mut conn, results + 1, "the launching turn").await;
    let a = conn.init_session_id(&pane);
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while rig.fresh_claude.session_busy(&pane).await != Some(false) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the launching turn left the session busy"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let boots_before = queries(&rig).len();

    let hold = rig.fresh_claude.hold_rollback_boot();
    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    tokio::time::timeout(RIG_FRAME_BUDGET, hold.parked())
        .await
        .expect("the gate admitted the undo while the session was idle");
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while rig.fresh_claude.session_busy(&pane).await != Some(true) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the background agent's completion never started a turn"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    hold.release();

    let refused = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(refused["type"], "freshAgent.error", "{refused}");
    assert_eq!(refused["code"], "BUSY_TURN", "{refused}");
    assert_eq!(
        queries(&rig).len(),
        boots_before,
        "the refused undo booted nothing"
    );
    assert!(
        ledger(&rig).load_rollback_row("claude", &a).is_none(),
        "the pre-written record was compensated"
    );
    wait_for_results(&mut conn, results + 2, "the CLI's own turn").await;
    assert_eq!(conn.init_session_id(&pane), a);
}

/// The replacement fails to boot (here: A's transcript is moved away while the
/// undo is parked before the boot, so the CLI cannot find the conversation to
/// fork). The undo answers a retryable error, compensates its record, and A is
/// untouched: still live, and it takes a send.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_that_cannot_boot_leaves_the_original_live() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let hold = rig.fresh_claude.hold_rollback_boot();
    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    hold.parked().await;
    let aside = a_path.with_extension("moved");
    std::fs::rename(&a_path, &aside).expect("move A's transcript away");
    hold.release();

    let failed = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(failed["type"], "freshAgent.error", "{failed}");
    assert_eq!(failed["code"], "INTERNAL_ERROR", "{failed}");
    std::fs::rename(&aside, &a_path).expect("put A's transcript back");
    assert!(ledger(&rig).load_rollback_row("claude", &a).is_none());
    assert!(rig.fresh_claude.has_live_session(&a).await);
    assert_eq!(
        conn.frames
            .iter()
            .filter(|v| v["type"] == "freshAgent.session.materialized")
            .count(),
        0
    );

    converse(&rig, &mut conn, &pane, &["third prompt"]).await;
    assert_eq!(
        conn.request_errors(&format!("send-{pane}-0")),
        Vec::<Value>::new()
    );
}

/// §4.5: a send that parked on the session's turn lock while the undo ran lands
/// on the replacement C, never on the stopped A and never on a revived A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_parked_behind_an_undo_runs_in_the_fork() {
    let logs = common::log_capture::install();
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let hold = rig.fresh_claude.hold_rollback_boot();
    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    hold.parked().await;
    // The pane's next message, sent before it saw the re-key.
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-parked", "sent during the undo")
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    hold.release();

    let (ack, c) = {
        let ack = rollback_answer(&mut conn, "undo-1").await;
        let c = ack["newSessionId"].as_str().expect("C").to_string();
        (ack, c)
    };
    assert_eq!(ack["type"], "freshAgent.rolledBack", "{ack}");
    wait_for_results(&mut conn, results + 1, "the parked send").await;
    assert_eq!(conn.request_errors("send-parked"), Vec::<Value>::new());
    let prompt = rig
        .ledger_rows("prompt")
        .into_iter()
        .find(|row| row["text"] == "sent during the undo")
        .expect("the parked send ran");
    assert_eq!(
        prompt["sessionId"],
        c.as_str(),
        "it ran in the fork: {prompt}"
    );
    let c_path = rig.wait_for_transcript(&c).await;
    assert!(chain_lines(&c_path)
        .iter()
        .any(|line| line["message"]["content"][0]["text"] == "sent during the undo"));
    assert!(!std::fs::read_to_string(&a_path)
        .expect("read A")
        .contains("sent during the undo"));
    // It found C through the durable supersession chain from A, not a
    // forward kept in memory.
    let followed = logs.matching(|event| {
        event.field("event") == Some("freshagent.claude.send_followed_replacement")
            && event.field("replacement") == Some(c.as_str())
    });
    assert_eq!(followed.len(), 1, "{followed:?}");
    assert_eq!(followed[0].field("through_ledger_chain"), Some("true"));
}

/// §4.3 "undo, then restart before sending": C's binding still holds its fork
/// genesis, so after a restart the pane's attach boots the same lazy fork under
/// C, its snapshot is the kept prefix, and its first send writes C.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_fork_survives_a_restart_with_its_prefix() {
    let mut rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    let prefix = snapshot_turn_ids(&rig, &c).await;
    drop(conn);

    rig.restart().await;
    assert_eq!(
        snapshot_turn_ids(&rig, &c).await,
        prefix,
        "served from the genesis"
    );
    let mut conn = rig.connect().await;
    conn.attach(&c).await;
    let boots: Vec<Value> = queries(&rig)
        .into_iter()
        .filter(|o| o["sessionId"] == c.as_str())
        .collect();
    assert_eq!(
        boots.len(),
        2,
        "the undo's boot and the restart's: {boots:?}"
    );
    assert_eq!(boots[1]["forkSession"], true, "{:?}", boots[1]);
    assert_eq!(boots[1]["resume"], a.as_str(), "{:?}", boots[1]);
    converse(&rig, &mut conn, &c, &["after the restart"]).await;
    assert_eq!(conn.init_session_id(&c), c);
    rig.wait_for_transcript(&c).await;
    let turns = snapshot_turn_ids(&rig, &c).await;
    assert!(
        turns.starts_with(&prefix) && turns.len() > prefix.len(),
        "{turns:?}"
    );
}

/// G14: the fork's sidecar log lines are bound to the replacement's id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_forks_sidecar_log_is_bound_to_the_new_session() {
    let logs = common::log_capture::install();
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    let bound = logs.matching(|event| {
        event.message == "freshagent.claude.sidecar_bound"
            && event.field("session_id") == Some(c.as_str())
    });
    assert_eq!(bound.len(), 1, "{bound:?}");
    assert_eq!(bound[0].field("session_type"), Some("freshclaude"));
}

// ── G28: an unreadable transcript store never reads as an empty one ──────────

/// Makes a directory unreadable and restores it on drop. `None` when the process
/// bypasses permission bits (root), where EACCES cannot be produced.
struct UnreadableDir(PathBuf);
impl UnreadableDir {
    fn with_mode(dir: &Path, mode: u32) -> Option<Self> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).unwrap();
        let guard = Self(dir.to_path_buf());
        if std::fs::read_dir(dir).is_ok() {
            eprintln!("skipping: euid bypasses permission checks");
            return None;
        }
        Some(guard)
    }
}
impl Drop for UnreadableDir {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

/// An undo while the store cannot be read is a retryable INTERNAL_ERROR, never
/// NOTHING_TO_UNDO; nothing is forked and no record is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_with_an_unreadable_store_is_internal_error_not_nothing_to_undo() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let boots = queries(&rig).len();
    let Some(_locked) = UnreadableDir::with_mode(&rig.claude_config_dir.join("projects"), 0o000)
    else {
        return;
    };
    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    let refused = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(refused["code"], "INTERNAL_ERROR", "{refused}");
    assert_eq!(queries(&rig).len(), boots, "nothing was forked");
    assert!(ledger(&rig).load_rollback_row("claude", &a).is_none());
}

/// A redo whose original cannot be read is a retryable INTERNAL_ERROR, never
/// REDO_UNAVAILABLE; the record stays redoable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_redo_with_an_unreadable_original_is_internal_error_not_redo_unavailable() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    let boots = queries(&rig).len();
    let Some(_locked) = UnreadableDir::with_mode(&rig.claude_config_dir.join("projects"), 0o000)
    else {
        return;
    };
    request_rollback(&mut conn, "redo", &c, &c, "redo-1", None).await;
    let refused = rollback_answer(&mut conn, "redo-1").await;
    assert_eq!(refused["code"], "INTERNAL_ERROR", "{refused}");
    assert_eq!(queries(&rig).len(), boots, "nothing was forked");
    let record = ledger(&rig)
        .load_rollback_row("claude", &c)
        .expect("the record");
    assert_eq!(record["canRedo"], true, "{record}");
}

/// The fork resumes the transcript the undo already located, in that
/// transcript's own directory, even when the store stops listing between the
/// lookup and the boot (a second scan there would miss and lose the cwd).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undo_forks_from_the_transcript_it_located_even_if_the_store_stops_listing() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let hold = rig.fresh_claude.hold_rollback_boot();
    request_rollback(&mut conn, "undo", &pane, &a, "undo-1", None).await;
    hold.parked().await;
    let Some(locked) = UnreadableDir::with_mode(&rig.claude_config_dir.join("projects"), 0o111)
    else {
        hold.release();
        return;
    };
    let boots = queries(&rig).len();
    hold.release();
    // The fork's query() is recorded before the simulated CLI boots (600 ms);
    // the store lists again before the CLI looks for the parent.
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while queries(&rig).len() == boots {
        assert!(tokio::time::Instant::now() < deadline, "no fork boot");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(locked);
    let fork = queries(&rig)
        .into_iter()
        .nth(boots)
        .expect("the fork's boot");
    assert_eq!(fork["resume"], a.as_str(), "{fork}");
    assert_eq!(
        fork["cwd"],
        rig.workspace.to_str().expect("utf-8"),
        "the fork runs in the located transcript's own cwd: {fork}"
    );
    let ack = rollback_answer(&mut conn, "undo-1").await;
    assert_eq!(ack["type"], "freshAgent.rolledBack", "{ack}");
}

// ── §4.2/§4.3: a dead pending session resumes through the create lane ─────────

/// SIGKILL the sidecar of the runtime that booted `session_id`, then wait for
/// the pane's `SIDECAR_EXITED` (the pane then shows "Resume session").
async fn kill_sidecar_of(rig: &ClaudeRig, conn: &mut RigConnection, session_id: &str) {
    let [sidecar, _cli] = rig.runtime_pids(session_id);
    // SAFETY: a plain signal to a sidecar process this rig's server spawned.
    assert_eq!(unsafe { libc::kill(sidecar as i32, libc::SIGKILL) }, 0);
    conn.wait_for("the sidecar's exit", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;
}

/// The create the pane's Resume sends for a dead claude session
/// (`FreshAgentView.triggerRecovery`, then `buildCreateMessage`): a new request
/// carrying the session as its `sessionRef`. Returns the `freshAgent.created`
/// frame.
async fn resume_through_create(conn: &mut RigConnection, session_id: &str) -> Value {
    let created = conn
        .request_create(
            &format!("resume-{session_id}"),
            json!({ "sessionRef": { "provider": "claude", "sessionId": session_id } }),
        )
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    assert_eq!(
        created["sessionRef"],
        json!({ "provider": "claude", "sessionId": session_id }),
        "{created}"
    );
    created
}

/// Every recorded `query()` boot under `session_id`, in order.
fn boots_under(rig: &ClaudeRig, session_id: &str) -> Vec<Value> {
    queries(rig)
        .into_iter()
        .filter(|o| o["sessionId"] == session_id)
        .collect()
}

/// §4.3 (sidecar crash row): the replacement an undo booted has no transcript
/// until its first send. When its sidecar dies before then, the pane's Resume
/// (a create resuming C) boots C from the genesis its binding row records, the
/// same guarded fork of A under C (a plain resume of C is refused by the CLI,
/// T5), and the next send writes C with A's kept prefix.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_undos_replacement_whose_sidecar_died_resumes_through_the_create() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    let fork = boot_of(&rig, &c);
    kill_sidecar_of(&rig, &mut conn, &c).await;

    let created = resume_through_create(&mut conn, &c).await;
    let boots = boots_under(&rig, &c);
    assert_eq!(boots.len(), 2, "the fork booted again under C: {boots:?}");
    for key in [
        "resume",
        "forkSession",
        "resumeSessionAt",
        "resumeDropsTurn",
    ] {
        assert_eq!(boots[1][key], fork[key], "{key}: {:?}", boots[1]);
    }
    assert_eq!(boots[1]["resume"], a.as_str());

    let resumed = created["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    converse(&rig, &mut conn, &resumed, &["after the crash"]).await;
    assert_eq!(conn.init_session_id(&resumed), c, "the CLI ran under C");
    let c_lines = chain_lines(&rig.wait_for_transcript(&c).await);
    let prompts: Vec<&str> = c_lines
        .iter()
        .filter(|line| line["type"] == "user")
        .filter_map(|line| line["message"]["content"][0]["text"].as_str())
        .collect();
    assert_eq!(prompts, ["first prompt", "after the crash"]);
}

/// §4.3: a first-turn undo's replacement (genesis `Fresh`) whose sidecar died
/// before its first send comes back through the create as a fresh boot under
/// C, never a resume of a conversation that was never written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fresh_replacement_whose_sidecar_died_resumes_through_the_create() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["only prompt"]).await;
    let a = conn.init_session_id(&pane);
    let (_, c) = rollback_ok(&mut conn, "undo", &pane, &a, "undo-1").await;
    materialized_from(&mut conn, &pane).await;
    kill_sidecar_of(&rig, &mut conn, &c).await;

    let created = resume_through_create(&mut conn, &c).await;
    let boots = boots_under(&rig, &c);
    assert_eq!(boots.len(), 2, "C booted fresh again: {boots:?}");
    assert_eq!(boots[1].get("resume"), None, "{:?}", boots[1]);
    assert_eq!(boots[1].get("forkSession"), None, "{:?}", boots[1]);

    let resumed = created["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    converse(&rig, &mut conn, &resumed, &["a new first prompt"]).await;
    assert_eq!(conn.init_session_id(&resumed), c, "the CLI ran under C");
}

// ── §3.3: configure and /compact serialize behind an undo on its turn lock ───

/// A frame sent while an undo holds the session's turn lock (the replacement's
/// boot is parked), so its handler is parked on that lock when the undo
/// replaces the runtime. Returns the replacement's id and how many frames the
/// connection had read before the parked frame was sent.
async fn park_behind_an_undo(
    rig: &ClaudeRig,
    conn: &mut RigConnection,
    pane: &str,
    a: &str,
    frame: Value,
) -> (String, usize) {
    let hold = rig.fresh_claude.hold_rollback_boot();
    request_rollback(conn, "undo", pane, a, "undo-1", None).await;
    hold.parked().await;
    let seen = conn.frames.len();
    conn.send(frame).await;
    // The handler resolves the session and waits on the undo's turn lock.
    conn.read_for(Duration::from_millis(300)).await;
    hold.release();
    let ack = rollback_answer(conn, "undo-1").await;
    assert_eq!(ack["type"], "freshAgent.rolledBack", "{ack}");
    let c = ack["newSessionId"]
        .as_str()
        .expect("the replacement")
        .to_string();
    (c, seen)
}

/// The first frame matching `predicate` among those read after the first
/// `seen` (an answer to a request sent then, never an older frame).
async fn frame_after(
    conn: &mut RigConnection,
    seen: usize,
    what: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        if let Some(hit) = conn.frames[seen..].iter().find(|v| predicate(v)) {
            return hit.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no {what}; frames: {:?}",
            &conn.frames[seen..]
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

fn lost_frames(conn: &RigConnection) -> Vec<Value> {
    conn.frames
        .iter()
        .filter(|v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.error"
                && matches!(
                    v["event"]["code"].as_str(),
                    Some("INVALID_SESSION_ID" | "CLAUDE_SETTINGS_FAILED")
                )
        })
        .cloned()
        .collect()
}

/// A model change sent while an undo boots its replacement waits on the
/// session's turn lock (design §3.3), then applies to the replacement C the
/// pane now shows: the CLI behind C takes the model, C's binding records it
/// and the pane gets C's metadata. It is never dropped against the retired A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_configure_parked_behind_an_undo_applies_to_the_replacement() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let configure = json!({
        "type": "freshAgent.configure",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane,
        "requestId": "configure-1",
        "settings": { "model": "claude-opus-parked" },
    });
    let (c, seen) = park_behind_an_undo(&rig, &mut conn, &pane, &a, configure).await;

    let answer = frame_after(
        &mut conn,
        seen,
        "the configure's metadata or its failure",
        |v| {
            v["type"] == "freshAgent.event"
                && ((v["event"]["type"] == "freshAgent.session.metadata"
                    && v["event"]["model"] == "claude-opus-parked")
                    || v["event"]["type"] == "freshAgent.error")
        },
    )
    .await;
    assert_eq!(
        answer["event"]["type"], "freshAgent.session.metadata",
        "{answer}"
    );
    assert_eq!(answer["event"]["sessionId"], c.as_str(), "{answer}");
    assert!(lost_frames(&conn).is_empty(), "{:?}", lost_frames(&conn));
    assert_eq!(
        ledger(&rig)
            .load_binding("claude", &c)
            .expect("C's row")
            .model
            .as_deref(),
        Some("claude-opus-parked")
    );
}

/// A /compact sent while an undo boots its replacement waits on the session's
/// turn lock, then compacts the replacement C the pane now shows (its turn
/// runs under C), never answered with a lost-session frame for the retired A.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compact_parked_behind_an_undo_runs_on_the_replacement() {
    let rig = rollback_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let results = conn.events_seen("freshAgent.result");
    let compact = json!({
        "type": "freshAgent.compact",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane,
        "requestId": "compact-1",
    });
    let (c, seen) = park_behind_an_undo(&rig, &mut conn, &pane, &a, compact).await;

    assert_eq!(
        conn.events_seen("freshAgent.result"),
        results,
        "nothing ran while the undo held the lock"
    );
    let answer = frame_after(
        &mut conn,
        seen,
        "the compact's result or its failure",
        |v| {
            v["type"] == "freshAgent.event"
                && matches!(
                    v["event"]["type"].as_str(),
                    Some("freshAgent.result" | "freshAgent.error")
                )
        },
    )
    .await;
    assert_eq!(answer["event"]["type"], "freshAgent.result", "{answer}");
    assert_eq!(answer["sessionId"], c.as_str(), "{answer}");
    assert!(lost_frames(&conn).is_empty(), "{:?}", lost_frames(&conn));
}
