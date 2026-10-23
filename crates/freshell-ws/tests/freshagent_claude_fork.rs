//! Fork a freshclaude conversation (core design §4.5 `handle_fork`, C14; audit
//! G09).
//!
//! Every test runs the REAL claude sidecar over the CLI simulator
//! (RealSidecarSim), with a real pane ledger and the ownership coordinator wired
//! the way main.rs wires them. The simulator boots like the pinned CLI: a lazy
//! fork (`resume`, `resumeSessionAt`, `forkSession`, `sessionId`) boots with no
//! prompt and writes nothing until its first prompt, which writes the child's
//! transcript with the parent's prefix (line uuids kept) and leaves the parent's
//! untouched (T6).
//!
//! A fork mints the child's id (C), boots the fork of the parent's (A's)
//! effective transcript under C while A stays live, records C's binding (genesis
//! `Fork{A, at}`, no `supersedes`), and answers `freshAgent.forked` on the
//! requesting connection only. The child is live at once (decision 5): the pane
//! switches to it and closes A itself.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use freshell_protocol::SessionType;

/// A fork answers within this budget: the child's boot takes about a second.
const FORK_BUDGET: Duration = Duration::from_secs(20);

async fn fork_rig() -> ClaudeRig {
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
/// (T3), and a fork reads the transcript.
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

/// `freshAgent.fork` from the pane `pane_id` the way `FreshAgentView` sends it:
/// the pane's create request id, its tab, the turn to fork at (none: the tip),
/// and the owner pair the client holds for the session's durable id.
async fn request_fork(
    conn: &mut RigConnection,
    pane_id: &str,
    durable: &str,
    request_id: &str,
    at_turn_id: Option<&str>,
) {
    let mut frame = json!({
        "type": "freshAgent.fork",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": pane_id,
        "requestId": request_id,
        "tabId": "tab-fork",
    });
    if let Some((epoch, generation)) = conn.owner_pair(durable) {
        frame["observedEpoch"] = json!(epoch);
        frame["observedGeneration"] = json!(generation);
    }
    if let Some(turn_id) = at_turn_id {
        frame["input"] = json!({ "atTurnId": turn_id });
    }
    conn.send(frame).await;
}

/// The requester's answer to a fork of `pane_id`: `freshAgent.forked` for
/// `request_id`, or the nested `freshAgent.error` naming the pane, among the
/// frames read after `seen` (the request's own answer, never an older one),
/// within [`FORK_BUDGET`].
async fn fork_answer(
    conn: &mut RigConnection,
    pane_id: &str,
    request_id: &str,
    seen: usize,
) -> Value {
    let started = tokio::time::Instant::now();
    let deadline = started + FORK_BUDGET;
    loop {
        if let Some(answer) = conn.frames[seen..].iter().find(|v| {
            (v["type"] == "freshAgent.forked" && v["requestId"] == request_id)
                || (v["type"] == "freshAgent.event"
                    && v["event"]["type"] == "freshAgent.error"
                    && v["event"]["sessionId"] == pane_id)
        }) {
            eprintln!(
                "{}",
                json!({ "severity": "info", "event": "fork_answered", "request": request_id,
                        "ms": started.elapsed().as_millis() as u64 })
            );
            return answer.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fork {request_id} was not answered within {FORK_BUDGET:?}; frames: {:?}",
            conn.frames
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

/// A fork that must succeed: the `forked` frame and the child id it names.
async fn fork_ok(
    conn: &mut RigConnection,
    pane_id: &str,
    durable: &str,
    request_id: &str,
    at_turn_id: Option<&str>,
) -> (Value, String) {
    let seen = conn.frames.len();
    request_fork(conn, pane_id, durable, request_id, at_turn_id).await;
    let forked = fork_answer(conn, pane_id, request_id, seen).await;
    assert_eq!(forked["type"], "freshAgent.forked", "{forked}");
    let child = forked["sessionId"]
        .as_str()
        .expect("forked names the child")
        .to_string();
    (forked, child)
}

/// A fork that must be refused: the nested error's code and message.
async fn fork_refused(
    conn: &mut RigConnection,
    pane_id: &str,
    durable: &str,
    request_id: &str,
    at_turn_id: Option<&str>,
) -> Value {
    let seen = conn.frames.len();
    request_fork(conn, pane_id, durable, request_id, at_turn_id).await;
    let answer = fork_answer(conn, pane_id, request_id, seen).await;
    assert_eq!(answer["type"], "freshAgent.event", "{answer}");
    answer["event"].clone()
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

fn prompt_uuid(lines: &[Value], text: &str) -> String {
    lines
        .iter()
        .find(|line| line["type"] == "user" && line["message"]["content"][0]["text"] == text)
        .and_then(|line| line["uuid"].as_str())
        .unwrap_or_else(|| panic!("no transcript line for {text}"))
        .to_string()
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

/// G09: a fork at the first turn answers `freshAgent.forked` on the requesting
/// connection only, naming the parent the pane addressed and a new UUID child C
/// that is live at once (decision 5). C boots as the lazy fork of A through the
/// first turn's last line, with no drops-turn guard (a fork discards nothing of
/// A); C's binding records that genesis and does not supersede A. C's snapshot
/// is A's prefix with the same turn ids, and A is untouched: its transcript, its
/// binding and its runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_answers_the_requester_with_a_live_child_holding_the_parents_prefix() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let mut other = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let a_before = std::fs::read_to_string(&a_path).expect("read A");
    let lines = chain_lines(&a_path);
    let u1 = prompt_uuid(&lines, "first prompt");
    let keep = uuid_before(&lines, &prompt_uuid(&lines, "second prompt"));
    let a_turns = snapshot_turn_ids(&rig, &a).await;

    let (forked, c) = fork_ok(&mut conn, &pane, &a, "fork-1", Some(&u1)).await;
    assert_eq!(forked["requestId"], "fork-1", "{forked}");
    assert_eq!(forked["parentSessionId"], pane.as_str(), "{forked}");
    assert_eq!(forked["provider"], "claude", "{forked}");
    assert_eq!(forked["runtimeProvider"], "claude", "{forked}");
    assert_eq!(forked["sessionType"], "freshclaude", "{forked}");
    assert_eq!(
        forked["sessionRef"],
        json!({ "provider": "claude", "sessionId": c })
    );
    assert_eq!(
        forked.get("parentRetiredByRuntime"),
        None,
        "the pane closes the parent itself: {forked}"
    );
    assert!(is_uuid(&c) && c != a, "C is a new UUID: {c}");

    other.read_for(Duration::from_millis(500)).await;
    assert!(
        !other
            .frames
            .iter()
            .any(|v| v["type"] == "freshAgent.forked"),
        "forked goes to the requesting connection only"
    );

    let boot = boot_of(&rig, &c);
    assert_eq!(boot["forkSession"], true, "{boot}");
    assert_eq!(boot["resume"], a.as_str(), "{boot}");
    assert_eq!(boot["resumeSessionAt"], keep.as_str(), "{boot}");
    assert_eq!(boot.get("resumeDropsTurn"), None, "{boot}");

    let row = ledger(&rig).load_binding("claude", &c).expect("C's row");
    assert_eq!(
        row.genesis,
        Some(json!({ "kind": "fork", "parent": a, "at": keep }))
    );
    assert_eq!(row.mode, "freshclaude");
    assert_eq!(row.cwd.as_deref(), rig.workspace.to_str());
    assert_eq!(
        ledger(&rig)
            .load_binding("claude", &a)
            .expect("A's row")
            .superseded_by,
        None,
        "a fork never supersedes its parent"
    );

    let c_turns = snapshot_turn_ids(&rig, &c).await;
    assert!(
        !c_turns.is_empty() && c_turns.len() < a_turns.len() && a_turns.starts_with(&c_turns),
        "C holds A's first turn with its ids: C {c_turns:?}, A {a_turns:?}"
    );
    assert_eq!(transcript_of(&rig, &c), None, "the fork writes nothing yet");
    assert_eq!(std::fs::read_to_string(&a_path).expect("read A"), a_before);
    assert!(rig.fresh_claude.has_live_session(&c).await, "C is live");
    assert!(rig.fresh_claude.has_live_session(&a).await, "A is live");
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        conn.events_seen("freshAgent.result"),
        "a fork never rings"
    );
}

/// The pane switches to C and closes A (the client's own kill); C's first send
/// runs under C (the CLI reports C), writes C's transcript (A's prefix lines
/// with their uuids, then the new turn) and clears the genesis, with no re-key:
/// the id the pane holds is the id the conversation lives under. C's turn
/// writes nothing to A's transcript. (A closing CLI may record its own
/// bookkeeping there: the pinned CLI appends a `last-prompt` line at shutdown.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_childs_first_send_materializes_under_the_same_id() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let u1 = prompt_uuid(&chain_lines(&a_path), "first prompt");
    let (_, c) = fork_ok(&mut conn, &pane, &a, "fork-1", Some(&u1)).await;
    let prefix = snapshot_turn_ids(&rig, &c).await;
    conn.kill(&pane).await;
    let a_before = std::fs::read_to_string(&a_path).expect("read A");

    converse(&rig, &mut conn, &c, &["a different second prompt"]).await;
    assert_eq!(conn.init_session_id(&c), c, "the CLI ran under C");
    let c_path = rig.wait_for_transcript(&c).await;
    rig.wait_for_genesis_cleared(&c).await;
    assert!(
        !conn
            .frames
            .iter()
            .any(|v| v["type"] == "freshAgent.session.materialized"),
        "no re-key: {:?}",
        conn.frames
    );
    let c_lines = chain_lines(&c_path);
    let a_lines = chain_lines(&a_path);
    assert_eq!(
        c_lines[0]["uuid"], a_lines[0]["uuid"],
        "A's lines keep their uuids"
    );
    assert!(c_lines
        .iter()
        .any(|line| line["message"]["content"][0]["text"] == "a different second prompt"));
    assert!(!c_lines
        .iter()
        .any(|line| line["message"]["content"][0]["text"] == "second prompt"));
    let materialized = snapshot_turn_ids(&rig, &c).await;
    assert!(
        materialized.starts_with(&prefix) && materialized.len() > prefix.len(),
        "the prefix leads C with the same turn ids: {prefix:?} then {materialized:?}"
    );
    assert_eq!(std::fs::read_to_string(&a_path).expect("read A"), a_before);
}

/// A fork while the parent runs a turn is refused BUSY_TURN and boots nothing;
/// once the turn finished, the same fork succeeds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_while_the_parent_is_busy_is_refused_busy_turn() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let a = conn.init_session_id(&pane);
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(&pane, "send-busy", "TOOL:sleep=2 then answer")
        .await;
    conn.wait_for("the busy send's acceptance", |v| {
        v["type"] == "freshAgent.send.accepted" && v["requestId"] == "send-busy"
    })
    .await;
    let boots = queries(&rig).len();

    let refused = fork_refused(&mut conn, &pane, &a, "fork-busy", None).await;
    assert_eq!(refused["code"], "BUSY_TURN", "{refused}");
    assert_eq!(refused["sessionId"], pane.as_str(), "{refused}");
    assert_eq!(queries(&rig).len(), boots, "nothing was booted");

    wait_for_results(&mut conn, results + 1, "the busy turn").await;
    let (_, c) = fork_ok(&mut conn, &pane, &a, "fork-idle", None).await;
    assert!(is_uuid(&c) && c != a, "{c}");
}

/// §4.5 source collapse: a fork of a fork that has not been sent to yet forks
/// the original at the same point (chains never nest), so it boots although
/// the first child has no transcript.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_of_a_pending_fork_forks_its_parent() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let lines = chain_lines(&a_path);
    let u1 = prompt_uuid(&lines, "first prompt");
    let keep = uuid_before(&lines, &prompt_uuid(&lines, "second prompt"));
    let (_, c1) = fork_ok(&mut conn, &pane, &a, "fork-1", Some(&u1)).await;

    let (forked, c2) = fork_ok(&mut conn, &c1, &c1, "fork-2", None).await;
    assert_eq!(forked["parentSessionId"], c1.as_str(), "{forked}");
    assert!(is_uuid(&c2) && c2 != c1 && c2 != a, "{c2}");
    let boot = boot_of(&rig, &c2);
    assert_eq!(
        boot["resume"],
        a.as_str(),
        "the fork of a fork forks A: {boot}"
    );
    assert_eq!(boot["resumeSessionAt"], keep.as_str(), "{boot}");
    assert_eq!(
        snapshot_turn_ids(&rig, &c2).await,
        snapshot_turn_ids(&rig, &c1).await
    );
    converse(&rig, &mut conn, &c2, &["after two forks"]).await;
    assert_eq!(conn.init_session_id(&c2), c2);
}

/// A fork at a turn the conversation does not hold is refused FORK_REFUSED and
/// boots nothing; the parent stays live.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_at_a_turn_the_conversation_does_not_hold_is_refused() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, _) = two_turns(&rig, &mut conn).await;
    let boots = queries(&rig).len();
    let refused = fork_refused(
        &mut conn,
        &pane,
        &a,
        "fork-missing",
        Some("00000000-0000-4000-8000-000000000000"),
    )
    .await;
    assert_eq!(refused["code"], "FORK_REFUSED", "{refused}");
    assert_eq!(queries(&rig).len(), boots, "nothing was booted");
    assert!(rig.fresh_claude.has_live_session(&a).await);
}

/// §4.3: a fork's child has no transcript until its first send. When its
/// sidecar dies before then, the pane's Resume (a create carrying the child's
/// `sessionRef`, `FreshAgentView.triggerRecovery`) boots the child from the
/// genesis its binding row records, the same lazy fork of the parent under C
/// (a plain resume of C is refused by the CLI, T5), and the next send writes C
/// with the parent's prefix.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_child_whose_sidecar_died_before_its_first_send_resumes_through_the_create() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let (pane, a, a_path) = two_turns(&rig, &mut conn).await;
    let u1 = prompt_uuid(&chain_lines(&a_path), "first prompt");
    let (_, c) = fork_ok(&mut conn, &pane, &a, "fork-1", Some(&u1)).await;
    conn.kill(&pane).await;
    let fork = boot_of(&rig, &c);
    let sidecar = rig
        .ledger_rows("boot")
        .into_iter()
        .find(|row| row["sessionId"] == c.as_str())
        .and_then(|row| row["pid"].as_i64())
        .expect("the child's sidecar pid");
    // SAFETY: a plain signal to a sidecar process this rig's server spawned.
    assert_eq!(unsafe { libc::kill(sidecar as i32, libc::SIGKILL) }, 0);
    conn.wait_for("the child's sidecar exit", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;

    let created = conn
        .request_create(
            "resume-child",
            json!({ "sessionRef": { "provider": "claude", "sessionId": c } }),
        )
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let boots: Vec<Value> = queries(&rig)
        .into_iter()
        .filter(|o| o["sessionId"] == c.as_str())
        .collect();
    assert_eq!(boots.len(), 2, "the fork booted again under C: {boots:?}");
    for key in ["resume", "forkSession", "resumeSessionAt"] {
        assert_eq!(boots[1][key], fork[key], "{key}: {:?}", boots[1]);
    }

    let resumed = created["sessionId"]
        .as_str()
        .expect("a session id")
        .to_string();
    converse(&rig, &mut conn, &resumed, &["a different second prompt"]).await;
    assert_eq!(conn.init_session_id(&resumed), c, "the CLI ran under C");
    let c_lines = chain_lines(&rig.wait_for_transcript(&c).await);
    assert_eq!(c_lines[0]["uuid"], chain_lines(&a_path)[0]["uuid"]);
    assert!(!c_lines
        .iter()
        .any(|line| line["message"]["content"][0]["text"] == "second prompt"));
}

/// The user closes the pane (the client kills the parent) while the fork's
/// child is still booting. Nothing would ever show or close that child, so the
/// fork must not hand it out: it answers a refusal instead of `forked`, the
/// child's runtime is torn down (its sidecar and CLI are gone) and no binding
/// row offers it for restore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_the_pane_while_the_child_boots_leaves_no_child_behind() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let a = conn.init_session_id(&pane);
    let hold = rig.fresh_claude.hold_fork_child();
    let seen = conn.frames.len();
    request_fork(&mut conn, &pane, &a, "fork-1", None).await;
    hold.parked().await;
    let boot = queries(&rig)
        .into_iter()
        .find(|o| o["forkSession"] == true)
        .expect("the child booted");
    let child = boot["sessionId"]
        .as_str()
        .expect("the child's id")
        .to_string();
    let child_runtime = rig.runtime_processes(&child);
    conn.kill(&pane).await;
    hold.release();

    let answer = fork_answer(&mut conn, &pane, "fork-1", seen).await;
    assert_eq!(
        answer["type"], "freshAgent.event",
        "no child is handed out: {answer}"
    );
    assert_eq!(answer["event"]["code"], "FORK_REFUSED", "{answer}");
    assert!(
        !rig.fresh_claude.has_live_session(&child).await,
        "the child is torn down"
    );
    child_runtime.wait_until_exited("the child's runtime").await;
    assert!(
        ledger(&rig)
            .load_binding("claude", &child)
            .is_none_or(|row| row.state != freshell_ws::pane_ledger::RowState::Bound),
        "nothing offers the child for restore"
    );
}

/// A parent whose sidecar died on its own while the fork's child booted is
/// still the pane's (it shows the ended card, not a closed pane), so the fork
/// goes on and hands the pane its live child.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parent_that_dies_while_the_child_boots_still_gets_its_fork() {
    let rig = fork_rig().await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-1").await;
    converse(&rig, &mut conn, &pane, &["first prompt"]).await;
    let a = conn.init_session_id(&pane);
    let parent_sidecar = rig
        .ledger_rows("boot")
        .into_iter()
        .next()
        .and_then(|row| row["pid"].as_i64())
        .expect("the parent's sidecar pid");
    let hold = rig.fresh_claude.hold_fork_child();
    let seen = conn.frames.len();
    request_fork(&mut conn, &pane, &a, "fork-1", None).await;
    hold.parked().await;
    // SAFETY: a plain signal to a sidecar process this rig's server spawned.
    assert_eq!(
        unsafe { libc::kill(parent_sidecar as i32, libc::SIGKILL) },
        0
    );
    conn.wait_for("the parent's sidecar exit", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;
    hold.release();

    let answer = conn
        .wait_for("the fork's answer", |v| {
            v["type"] == "freshAgent.forked" && v["requestId"] == "fork-1"
        })
        .await;
    assert!(conn.frames.len() > seen);
    let child = answer["sessionId"].as_str().expect("the child").to_string();
    assert!(
        rig.fresh_claude.has_live_session(&child).await,
        "the child is live"
    );
}
