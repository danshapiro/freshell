//! [`ClaudeTurnLedger`] tests (design §5.2, §11.2; C17).
//!
//! The table tests replay the pinned CLI's recorded traces (scratch
//! `design-probe` H I J K L M N and the `final-probe` CLI-initiated turn) as the
//! lines the sidecar forwards for them, with the server's arms where the server
//! makes them (before the send is written). The property tests drive a model of
//! the CLI that keeps T8-T10 (per-command lifecycle, session state brackets,
//! sends absorbed into a tool call versus queued behind streamed text) through
//! random interleavings of sends and CLI frames: the ledger is busy exactly when
//! the CLI owes work, and every result is settled exactly once.

use std::collections::{HashSet, VecDeque};

use serde_json::{json, Value};

use super::*;

// ── line builders: what the sidecar forwards ─────────────────────────────────

fn command(uuid: &str, state: &str) -> Value {
    json!({ "type": "sdk.command", "sessionId": "s", "uuid": uuid, "state": state })
}

fn session_state(state: &str) -> Value {
    json!({ "type": "sdk.session.state", "sessionId": "s", "state": state })
}

fn init() -> Value {
    json!({
        "type": "sdk.session.init", "sessionId": "s", "cliSessionId": "c",
        "capabilities": ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    })
}

fn init_without_lifecycle() -> Value {
    json!({ "type": "sdk.session.init", "sessionId": "s", "cliSessionId": "c" })
}

fn requesting() -> Value {
    json!({ "type": "sdk.status", "sessionId": "s", "status": "requesting" })
}

fn compacting() -> Value {
    json!({ "type": "sdk.status", "sessionId": "s", "status": "compacting" })
}

fn status_ended() -> Value {
    json!({ "type": "sdk.status", "sessionId": "s", "status": null, "compactResult": "success" })
}

fn boundary() -> Value {
    json!({ "type": "sdk.compact_boundary", "sessionId": "s", "trigger": "auto" })
}

fn assistant() -> Value {
    json!({ "type": "sdk.assistant", "sessionId": "s", "content": [{ "type": "text", "text": "ok" }] })
}

fn stream() -> Value {
    json!({ "type": "sdk.stream", "sessionId": "s", "event": { "type": "content_block_delta" } })
}

fn result(subtype: &str) -> Value {
    json!({ "type": "sdk.result", "sessionId": "s", "subtype": subtype, "isError": subtype != "success" })
}

fn heartbeat() -> Value {
    json!({ "type": "sdk.heartbeat", "sessionId": "s", "kind": "task" })
}

/// One ledger driven the way the stdout consumer drives it: arms from the
/// handlers, folds from the sidecar's lines, with every settlement recorded.
#[derive(Default)]
struct Trace {
    ledger: ClaudeTurnLedger,
    /// The uuids each result retired, in result order.
    settlements: Vec<Vec<String>>,
    /// The results that retired by the old-CLI head fallback.
    head_retires: usize,
}

impl Trace {
    fn arm(&mut self, uuid: &str) -> &mut Self {
        self.ledger.arm(
            uuid.to_string(),
            Some(format!("request-{uuid}")),
            SendKind::Turn,
        );
        self
    }

    fn arm_compact(&mut self, uuid: &str) -> &mut Self {
        self.ledger.arm(uuid.to_string(), None, SendKind::Compact);
        self
    }

    fn feed(&mut self, line: Value) -> &mut Self {
        if let Some(fact) = TurnFact::from_line(&line) {
            if let Folded::Settled(settlement) = self.ledger.fold(&fact) {
                if settlement.head_retired {
                    self.head_retires += 1;
                }
                self.settlements.push(
                    settlement
                        .retired
                        .iter()
                        .map(|command| command.uuid.clone())
                        .collect(),
                );
            }
        }
        self
    }

    fn feed_all(&mut self, lines: impl IntoIterator<Item = Value>) -> &mut Self {
        for line in lines {
            self.feed(line);
        }
        self
    }

    fn busy(&self) -> bool {
        self.ledger.busy()
    }

    fn status(&self) -> &'static str {
        self.ledger.effective_status(false, false).as_str()
    }

    fn outstanding(&self) -> Vec<&str> {
        self.ledger.outstanding().collect()
    }
}

// ── recorded traces ──────────────────────────────────────────────────────────

/// H (warm interrupt during streamed text): the aborted result settles the
/// command; its trailing `cancelled` and the idle change nothing.
#[test]
fn trace_h_a_warm_interrupt_settles_at_the_aborted_result() {
    let mut t = Trace::default();
    t.arm("u");
    assert!(t.busy(), "busy from the arm, before the CLI says anything");
    assert_eq!(t.status(), "running");
    t.feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        init(),
        requesting(),
        command("u", "replayed"),
        assistant(),
    ]);
    assert!(t.busy());
    t.feed(result("error_during_execution"));
    assert!(!t.busy(), "the stopped turn ended at its result");
    assert_eq!(t.settlements, vec![vec!["u".to_string()]]);
    t.feed_all([command("u", "cancelled"), session_state("idle")]);
    assert!(!t.busy());
    assert_eq!(t.settlements.len(), 1, "the trailers settle nothing");
    assert_eq!(t.status(), "idle");
}

/// I (cold Stop: the receipt came back first and the command still ran to
/// success): one settlement, at its success result.
#[test]
fn trace_i_a_command_that_ran_after_a_cold_stop_settles_once() {
    let mut t = Trace::default();
    t.arm("u").feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        init(),
        requesting(),
        command("u", "replayed"),
        assistant(),
    ]);
    assert!(t.busy());
    t.feed(result("success"));
    assert!(!t.busy());
    t.feed_all([command("u", "completed"), session_state("idle")]);
    assert_eq!(t.settlements, vec![vec!["u".to_string()]]);
    assert!(!t.busy());
}

/// J (a send absorbed into a tool call, T10): both commands start inside the one
/// turn, the absorbed one completes before the result, the first after it. One
/// result settles the turn and nothing is left owed: an absorbed send never
/// wedges the session busy (G08).
#[test]
fn trace_j_an_absorbed_send_leaves_the_session_idle_after_the_one_result() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        init(),
        requesting(),
        command("a", "replayed"),
        assistant(),
    ]);
    // The second send, pushed during the tool call.
    t.arm("b").feed(command("b", "queued"));
    assert_eq!(t.outstanding(), vec!["a", "b"]);
    t.feed_all([
        heartbeat(),
        command("b", "replayed"),
        command("b", "started"),
        requesting(),
        assistant(),
        command("b", "completed"),
    ]);
    assert!(t.busy(), "the turn runs until its result");
    assert_eq!(t.outstanding(), vec!["a"], "b ended with its own lifecycle");
    t.feed(result("success"));
    assert!(!t.busy(), "one result settles the absorbed turn");
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    t.feed_all([command("a", "completed"), session_state("idle")]);
    assert!(!t.busy());
    assert_eq!(t.settlements.len(), 1);
    assert_eq!(t.status(), "idle");
}

/// J with the absorbed command's `completed` after the result: the result
/// retires every started command (only one turn runs, and absorbed commands
/// start inside it), so the late lifecycle finds nothing.
#[test]
fn an_absorbed_command_still_started_at_the_result_is_retired_by_it() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        assistant(),
    ]);
    t.arm("b").feed_all([
        command("b", "queued"),
        command("b", "replayed"),
        command("b", "started"),
        assistant(),
    ]);
    t.feed(result("success"));
    assert!(!t.busy());
    assert_eq!(t.settlements, vec![vec!["a".to_string(), "b".to_string()]]);
    t.feed_all([command("b", "completed"), command("a", "completed")]);
    assert_eq!(t.settlements.len(), 1);
    assert!(!t.busy());
}

/// K (cold Stop re-sent once the command started): the aborted result settles
/// the command.
#[test]
fn trace_k_a_re_sent_cold_stop_settles_at_the_aborted_result() {
    let mut t = Trace::default();
    t.arm("u").feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        init(),
        requesting(),
        command("u", "replayed"),
    ]);
    assert!(t.busy());
    t.feed(result("error_during_execution"));
    assert!(!t.busy());
    t.feed_all([command("u", "cancelled"), session_state("idle")]);
    assert_eq!(t.settlements, vec![vec!["u".to_string()]]);
}

/// L (a send pushed during streamed text queues as its own turn, T10): the
/// first result settles only the first command; the session stays busy for the
/// queued one (the client's `sessionBusy`), which its own result settles. The
/// CLI announces no idle between the two turns (T9).
#[test]
fn trace_l_a_queued_send_keeps_the_session_busy_between_its_results() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        init(),
        requesting(),
        command("a", "replayed"),
    ]);
    t.arm("b").feed_all([command("b", "queued"), assistant()]);
    t.feed(result("success"));
    assert!(t.busy(), "b is still owed after a's result");
    assert_eq!(t.status(), "running");
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    t.feed_all([
        command("a", "completed"),
        command("b", "started"),
        init(),
        requesting(),
        command("b", "replayed"),
        assistant(),
    ]);
    assert!(t.busy());
    t.feed(result("success"));
    assert!(!t.busy());
    t.feed_all([command("b", "completed"), session_state("idle")]);
    assert_eq!(
        t.settlements,
        vec![vec!["a".to_string()], vec!["b".to_string()]]
    );
    assert_eq!(t.status(), "idle");
}

/// M (`/compact` is an ordinary command with one result, T15): the session
/// reads `compacting` while the compaction runs, `running` after its status
/// ends, and the compact's own result settles it.
#[test]
fn trace_m_a_compact_is_a_command_with_its_own_result() {
    let mut t = Trace::default();
    t.arm("seed").feed_all([
        // A replay of a uuid the server never sent (the CLI's local-command
        // output) is not forwarded by the sidecar; one that slips through is
        // ignored.
        command("never-sent", "replayed"),
        session_state("running"),
        command("seed", "queued"),
        command("seed", "started"),
        init(),
        requesting(),
        command("seed", "replayed"),
        assistant(),
        result("success"),
        command("seed", "completed"),
        session_state("idle"),
    ]);
    assert!(!t.busy());
    t.arm_compact("c").feed_all([
        session_state("running"),
        command("c", "queued"),
        command("c", "started"),
    ]);
    assert_eq!(t.status(), "running");
    t.feed(compacting());
    assert_eq!(t.status(), "compacting");
    t.feed(json!({
        "type": "sdk.status", "sessionId": "s", "status": null, "compactResult": "failed",
        "compactError": "Not enough messages to compact.",
    }));
    assert_eq!(
        t.status(),
        "running",
        "the compaction ended; the command runs on"
    );
    t.feed_all([init(), assistant(), command("c", "replayed")]);
    assert!(t.busy());
    t.feed(result("success"));
    assert!(!t.busy());
    t.feed_all([command("c", "completed"), session_state("idle")]);
    assert_eq!(
        t.settlements,
        vec![vec!["seed".to_string()], vec!["c".to_string()]]
    );
}

/// N (the CLI is killed mid-turn, T14): no result arrives; the end of the
/// sidecar's output finds the turn owed, and clears everything.
#[test]
fn trace_n_a_cli_death_mid_turn_is_owed_at_the_end_of_output() {
    let mut t = Trace::default();
    t.arm("u").feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        init(),
        requesting(),
        command("u", "replayed"),
        assistant(),
    ]);
    assert!(t.ledger.eof(), "the turn was owed");
    assert!(!t.busy());
    assert!(t.outstanding().is_empty());
    assert!(!t.ledger.eof(), "nothing is owed twice");
}

/// The final-probe CLI-initiated turn (T9, T19): a background agent's completion
/// starts a turn with no uuid and no lifecycle. The session is busy from its
/// `running` until its result, which settles no command.
#[test]
fn the_cli_initiated_turn_is_busy_from_its_running_to_its_result() {
    let mut t = Trace::default();
    t.arm("u1").feed_all([
        session_state("running"),
        command("u1", "queued"),
        command("u1", "started"),
        init(),
        requesting(),
        command("u1", "replayed"),
        stream(),
        assistant(),
        heartbeat(),
        stream(),
        requesting(),
        stream(),
        assistant(),
        stream(),
    ]);
    t.feed(result("success"));
    assert!(!t.busy());
    t.feed_all([
        command("u1", "completed"),
        session_state("idle"),
        heartbeat(),
    ]);
    assert!(!t.busy(), "a background task's progress is not a turn");
    t.feed(session_state("running"));
    assert!(t.busy(), "the CLI started a turn of its own");
    assert_eq!(t.status(), "running");
    t.feed_all([init(), requesting(), stream(), assistant(), stream()]);
    assert!(t.busy());
    t.feed(result("success"));
    assert!(!t.busy());
    t.feed(session_state("idle"));
    assert_eq!(
        t.settlements,
        vec![vec!["u1".to_string()], Vec::<String>::new()],
        "the CLI's own turn settles with nothing retired"
    );
    assert_eq!(t.head_retires, 0);
}

// ── the rules one at a time ──────────────────────────────────────────────────

/// An armed command is owed before the CLI says anything about it: no send can
/// hide in a queue the server does not see (the property the deleted rollback
/// quiesce probe protected).
#[test]
fn an_armed_command_is_owed_before_the_cli_sees_it() {
    let mut t = Trace::default();
    t.arm_compact("c1");
    assert!(t.busy());
    assert_eq!(t.status(), "running");
    t.arm("s1").arm_compact("c2");
    assert_eq!(t.outstanding(), vec!["c1", "s1", "c2"]);
}

/// A session idle ends the turn and every started command (a started command
/// cannot outlive an idle) and any compaction; a command the CLI has not
/// reported yet stays owed, because a send just pushed can race an idle (T9).
#[test]
fn an_idle_ends_the_turn_and_every_started_command_but_not_a_just_pushed_send() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        compacting(),
    ]);
    t.arm("late");
    t.feed(session_state("idle"));
    assert_eq!(t.outstanding(), vec!["late"]);
    assert!(t.busy(), "the just-pushed send is still owed");
    assert_eq!(t.status(), "running", "the compaction ended with the idle");
    assert!(t.settlements.is_empty(), "an idle is not a result");
}

/// The legacy protocol fakes' `sdk.status idle` is the session idle: it releases
/// a turn whose result already came (the deleted legacy-idle test's property).
#[test]
fn a_legacy_idle_status_is_the_session_idle() {
    let mut t = Trace::default();
    t.feed(json!({ "type": "sdk.status", "sessionId": "s", "status": "running" }));
    assert!(t.busy(), "the legacy running status is turn evidence");
    t.feed(json!({ "type": "sdk.status", "sessionId": "s", "status": "idle" }));
    assert!(!t.busy());
}

/// Only a result, an idle or the end of output ends a turn. An error, a
/// compaction, assistant text, a heartbeat, an interrupt receipt (accepted or
/// rejected) and a configure answer never do (the deleted four-edge,
/// rejected-interrupt and interrupt-receipt tests' properties).
#[test]
fn only_a_result_an_idle_or_the_end_of_output_ends_a_turn() {
    let mut t = Trace::default();
    t.arm("u").feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        json!({ "type": "sdk.error", "sessionId": "s", "message": "boom" }),
        json!({ "type": "sdk.error", "sessionId": "s", "message": "failed", "turnFailure": true }),
        compacting(),
        boundary(),
        status_ended(),
        assistant(),
        stream(),
        heartbeat(),
        json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "ok": true, "stillQueued": [] }),
        json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "ok": false }),
        json!({ "type": "sdk.configured", "sessionId": "s", "requestId": "r", "ok": true }),
        json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "p" }),
    ]);
    assert!(t.busy());
    assert!(t.settlements.is_empty());
    t.feed(result("success"));
    assert!(!t.busy());

    t.arm("v").feed(command("v", "queued"));
    t.feed(session_state("running"));
    assert!(t.ledger.eof());
    assert!(!t.busy());
}

/// The trailers after a result (the command's `completed`, the idle) never open
/// a turn: a CLI death after a result but before its trailers owes nothing, so
/// it adds no second ring.
#[test]
fn the_trailers_after_a_result_never_reopen_the_turn() {
    let mut t = Trace::default();
    t.arm("u").feed_all([
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        assistant(),
        result("success"),
        command("u", "completed"),
    ]);
    assert!(!t.ledger.eof(), "nothing was owed after the result");
}

/// A turn that ends with an error result settles like any other, and the
/// queued commands behind an interrupted turn survive its aborted result: they
/// will still run (T12), and their own results settle them (the deleted
/// interrupt-attribution tests' property: an aborted result never retires the
/// next queued command).
#[test]
fn an_aborted_result_retires_only_the_running_command() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        assistant(),
    ]);
    t.arm_compact("c").feed(command("c", "queued"));
    t.arm("s").feed(command("s", "queued"));
    t.feed(result("error_during_execution"));
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    assert_eq!(t.outstanding(), vec!["c", "s"]);
    assert!(
        t.busy(),
        "the queued compact and send keep the session busy"
    );
    t.feed_all([
        command("a", "cancelled"),
        command("c", "started"),
        compacting(),
    ]);
    // The compact is stopped too: its aborted result retires only the compact.
    t.feed(result("error_during_execution"));
    assert_eq!(t.outstanding(), vec!["s"]);
    assert_eq!(t.status(), "running", "the stopped compaction is over");
    t.feed_all([
        command("c", "cancelled"),
        command("s", "started"),
        assistant(),
    ]);
    t.feed(result("success"));
    assert!(
        !t.busy(),
        "the session is idle exactly at the last command's result"
    );
    assert_eq!(
        t.settlements,
        vec![
            vec!["a".to_string()],
            vec!["c".to_string()],
            vec!["s".to_string()]
        ]
    );
}

/// An automatic compaction inside a running turn is the turn's: it settles no
/// command, and a `/compact` queued behind the turn stays owed until its own
/// result (the deleted compact-candidate tests' property).
#[test]
fn an_automatic_compaction_mid_turn_settles_no_queued_compact() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
    ]);
    t.arm_compact("c").feed(command("c", "queued"));
    t.feed(compacting());
    assert_eq!(t.status(), "compacting");
    t.feed_all([boundary(), status_ended()]);
    assert_eq!(t.status(), "running");
    assert_eq!(t.outstanding(), vec!["a", "c"]);
    t.feed(result("success"));
    assert_eq!(
        t.outstanding(),
        vec!["c"],
        "only the turn's own command settled"
    );
    assert!(t.busy());
    t.feed_all([command("c", "started"), compacting()]);
    assert_eq!(t.status(), "compacting");
    t.feed(result("success"));
    assert!(!t.busy());
    assert_eq!(
        t.status(),
        "idle",
        "a result ends a compaction that never reported its end"
    );
}

/// A compaction status is busy the moment it folds, even with no command owed
/// (a compaction the server could not attribute still keeps the rollback gate
/// closed; the deleted revived-compact tests' property).
#[test]
fn a_compaction_is_busy_from_its_status() {
    let mut t = Trace::default();
    t.feed(compacting());
    assert!(t.busy());
    assert_eq!(t.status(), "compacting");
    t.feed(status_ended());
    assert!(!t.busy());
}

/// A command the CLI drops without running it (`discarded`, `cancelled` before
/// it started) ends with its own lifecycle and nothing else: the commands
/// around it are untouched (the deleted dropped-compact tests' property).
#[test]
fn a_dropped_command_ends_with_its_own_lifecycle_only() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
    ]);
    t.arm_compact("c1").arm("s1").arm_compact("c2").feed_all([
        command("c1", "queued"),
        command("s1", "queued"),
        command("c2", "queued"),
        command("c1", "discarded"),
    ]);
    assert_eq!(t.outstanding(), vec!["a", "s1", "c2"]);
    t.feed(command("c2", "cancelled"));
    assert_eq!(t.outstanding(), vec!["a", "s1"]);
    // A lifecycle for a command already gone is ignored.
    assert!(matches!(
        t.ledger.fold(&TurnFact::Command {
            uuid: "c1".into(),
            state: CommandState::Completed
        }),
        Folded::UnknownCommand
    ));
    assert_eq!(t.outstanding(), vec!["a", "s1"]);
}

/// A lifecycle for a uuid the server never sent is ignored and reported.
#[test]
fn an_unknown_uuid_is_ignored() {
    let mut t = Trace::default();
    t.arm("a");
    for state in [
        CommandState::Queued,
        CommandState::Started,
        CommandState::Replayed,
        CommandState::Completed,
    ] {
        assert!(matches!(
            t.ledger.fold(&TurnFact::Command {
                uuid: "stranger".into(),
                state
            }),
            Folded::UnknownCommand
        ));
    }
    assert_eq!(t.outstanding(), vec!["a"]);
    assert!(!t.ledger.turn_open, "an unknown command never opens a turn");
}

/// A replay is the start of a command whose CLI sends no lifecycle; the first
/// of `started` and `replayed` wins and the second changes nothing.
#[test]
fn a_replay_starts_a_command_and_the_first_start_wins() {
    let mut t = Trace::default();
    t.arm("a").feed(command("a", "replayed"));
    assert!(t.ledger.turn_open);
    t.feed(command("a", "started"));
    t.feed(result("success"));
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    assert_eq!(t.head_retires, 0, "the replayed command settled by itself");
}

/// Turn evidence (a model request, assistant text, stream events) opens the
/// turn when the CLI announces no session state, and the result closes it. A
/// subagent's own output (with a parent tool use) is the parent's tool call,
/// not a turn, and an init alone opens nothing: every real turn opened before
/// its init, and the protocol fakes announce an init at create.
#[test]
fn turn_evidence_opens_a_turn_without_session_state() {
    let mut t = Trace::default();
    t.feed_all([init(), init_without_lifecycle()]);
    assert!(!t.busy(), "an init is not a turn");
    for evidence in [requesting(), assistant(), stream()] {
        let mut t = Trace::default();
        t.feed(evidence.clone());
        assert!(t.busy(), "{evidence}");
        t.feed(result("success"));
        assert!(!t.busy(), "{evidence}");
    }
    let mut t = Trace::default();
    t.feed(json!({
        "type": "sdk.stream", "sessionId": "s", "event": {}, "parentToolUseId": "toolu_1",
    }));
    t.feed(json!({
        "type": "sdk.assistant", "sessionId": "s", "content": [], "parentToolUseId": "toolu_1",
    }));
    assert!(
        !t.busy(),
        "a subagent's output is not a turn of the session's own"
    );
}

/// The old-CLI fallback (no lifecycle frames, no lifecycle capability on the
/// init): a result that started no command retires the oldest one the server
/// armed (an unknown slash command never replays, T8), and reports it.
#[test]
fn an_old_cli_result_retires_the_oldest_armed_command() {
    let mut t = Trace::default();
    t.arm("a")
        .arm("b")
        .feed_all([init_without_lifecycle(), assistant()]);
    t.feed(result("success"));
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    assert_eq!(t.head_retires, 1);
    assert!(t.busy(), "b is still owed");
    t.feed(result("success"));
    assert_eq!(t.head_retires, 2);
    assert!(!t.busy());
}

/// A lifecycle-capable CLI's result that started no command (a CLI-initiated
/// turn, a slash command the CLI ran before the send reached it) retires none:
/// a send armed and not yet started is never taken for another turn's result.
/// The capability comes from the first lifecycle frame or the init's
/// `msg_lifecycle_v1`.
#[test]
fn a_lifecycle_capable_result_retires_only_started_commands() {
    let mut by_init = Trace::default();
    by_init.feed(init());
    by_init.arm("a").feed(result("success"));
    assert_eq!(by_init.settlements, vec![Vec::<String>::new()]);
    assert_eq!(by_init.outstanding(), vec!["a"]);

    let mut by_lifecycle = Trace::default();
    by_lifecycle.arm("x").feed(command("x", "queued"));
    by_lifecycle.arm("a").feed(result("success"));
    assert_eq!(by_lifecycle.settlements, vec![Vec::<String>::new()]);
    assert_eq!(by_lifecycle.outstanding(), vec!["x", "a"]);
}

/// A send whose write failed or that the sidecar refused is taken back by its
/// own uuid: exactly that command leaves, whatever else is owed stays (the
/// deleted failed-compact-write tests' property), and a second take-back finds
/// nothing.
#[test]
fn a_send_is_taken_back_by_its_own_uuid() {
    let mut t = Trace::default();
    t.arm("a")
        .feed_all([session_state("running"), command("a", "started")]);
    t.arm("s1").arm_compact("c2");
    let taken = t.ledger.undo_arm("c2").expect("c2 is owed");
    assert_eq!(taken.uuid, "c2");
    assert_eq!(taken.kind, SendKind::Compact);
    assert_eq!(taken.request_id, None);
    assert_eq!(t.outstanding(), vec!["a", "s1"]);
    assert!(t.ledger.undo_arm("c2").is_none(), "taken back once");
    assert!(t.ledger.undo_arm("never-sent").is_none());
    t.feed(result("success"));
    assert!(t.busy(), "s1 is still owed after a's result");
    let s1 = t.ledger.undo_arm("s1").expect("s1 is owed");
    assert_eq!(s1.request_id.as_deref(), Some("request-s1"));
    assert!(!t.busy());
}

/// A send armed while the previous turn is still finishing (its result lands
/// between the arm and the write) is never settled by that turn's result (the
/// deleted write-window tests' property).
#[test]
fn a_result_during_a_sends_write_settles_only_the_running_command() {
    let mut t = Trace::default();
    t.arm("a").feed_all([
        session_state("running"),
        command("a", "queued"),
        command("a", "started"),
        assistant(),
    ]);
    t.arm("b");
    t.feed(result("success"));
    assert_eq!(t.settlements, vec![vec!["a".to_string()]]);
    assert_eq!(t.outstanding(), vec!["b"]);
    assert!(t.busy());
}

/// The end of the sidecar's output reports whether anything was owed and
/// clears the ledger.
#[test]
fn the_end_of_output_reports_what_was_owed() {
    let mut idle = Trace::default();
    assert!(!idle.ledger.eof(), "an idle session owes nothing");

    let mut armed = Trace::default();
    armed.arm("a");
    assert!(armed.ledger.eof(), "an armed send is owed");
    assert!(!armed.busy());

    let mut cli_turn = Trace::default();
    cli_turn.feed(session_state("running"));
    assert!(cli_turn.ledger.eof(), "the CLI's own turn is owed");

    let mut compaction = Trace::default();
    compaction.feed(compacting());
    assert!(compaction.ledger.eof());
}

/// `effective_status`: exited, else stuck, else compacting, else running while
/// busy, else idle.
#[test]
fn effective_status_precedence() {
    let mut t = Trace::default();
    assert_eq!(
        t.ledger.effective_status(false, false),
        EffectiveStatus::Idle
    );
    assert_eq!(
        t.ledger.effective_status(false, true),
        EffectiveStatus::Stuck
    );
    assert_eq!(
        t.ledger.effective_status(true, true),
        EffectiveStatus::Exited
    );
    t.arm("a");
    assert_eq!(
        t.ledger.effective_status(false, false),
        EffectiveStatus::Running
    );
    t.feed(compacting());
    assert_eq!(
        t.ledger.effective_status(false, false),
        EffectiveStatus::Compacting
    );
    assert_eq!(
        t.ledger.effective_status(false, true),
        EffectiveStatus::Stuck
    );
    assert_eq!(
        t.ledger.effective_status(true, false),
        EffectiveStatus::Exited
    );
    for (status, text) in [
        (EffectiveStatus::Idle, "idle"),
        (EffectiveStatus::Running, "running"),
        (EffectiveStatus::Compacting, "compacting"),
        (EffectiveStatus::Stuck, "stuck"),
        (EffectiveStatus::Exited, "exited"),
    ] {
        assert_eq!(status.as_str(), text);
    }
}

/// The status to publish is reported once per change: a fresh ledger has
/// published `idle`, an arm reports `running` once, and the settle reports
/// `idle` once.
#[test]
fn a_status_change_is_reported_once() {
    let mut t = Trace::default();
    assert_eq!(t.ledger.take_status_change(false), None);
    t.arm("a");
    assert_eq!(
        t.ledger.take_status_change(false),
        Some(EffectiveStatus::Running)
    );
    assert_eq!(t.ledger.take_status_change(false), None);
    t.feed(command("a", "started"));
    assert_eq!(t.ledger.take_status_change(false), None, "still running");
    t.feed(compacting());
    assert_eq!(
        t.ledger.take_status_change(false),
        Some(EffectiveStatus::Compacting)
    );
    t.feed(result("success"));
    assert_eq!(
        t.ledger.take_status_change(false),
        Some(EffectiveStatus::Idle)
    );
    assert_eq!(t.ledger.published_status(), EffectiveStatus::Idle);
    assert_eq!(t.ledger.take_status_change(false), None);
}

/// Every line kind the ledger folds, and the lines it does not.
#[test]
fn the_lines_the_ledger_folds() {
    let facts = [
        (
            command("u", "queued"),
            Some(TurnFact::Command {
                uuid: "u".into(),
                state: CommandState::Queued,
            }),
        ),
        (
            session_state("requires_action"),
            Some(TurnFact::SessionState(SessionState::RequiresAction)),
        ),
        (
            init(),
            Some(TurnFact::Init {
                lifecycle_capable: true,
            }),
        ),
        (
            init_without_lifecycle(),
            Some(TurnFact::Init {
                lifecycle_capable: false,
            }),
        ),
        (requesting(), Some(TurnFact::TurnEvidence)),
        (assistant(), Some(TurnFact::Content)),
        (stream(), Some(TurnFact::Content)),
        (compacting(), Some(TurnFact::CompactStarted)),
        (status_ended(), Some(TurnFact::CompactEnded)),
        (boundary(), Some(TurnFact::CompactEnded)),
        (
            result("success"),
            Some(TurnFact::Result(ResultFacts {
                subtype: "success".into(),
                ..ResultFacts::default()
            })),
        ),
        (
            json!({
                "type": "sdk.result", "subtype": "error_during_execution", "isError": true,
                "terminalReason": "aborted_tools", "numTurns": 3, "errorText": "boom",
            }),
            Some(TurnFact::Result(ResultFacts {
                subtype: "error_during_execution".into(),
                is_error: true,
                terminal_reason: Some("aborted_tools".into()),
                num_turns: Some(3),
                error_text: Some("boom".into()),
            })),
        ),
        (
            json!({ "type": "sdk.status", "status": "running" }),
            Some(TurnFact::TurnEvidence),
        ),
        (
            json!({ "type": "sdk.status", "status": "idle" }),
            Some(TurnFact::SessionState(SessionState::Idle)),
        ),
        (json!({ "type": "sdk.error", "message": "boom" }), None),
        (heartbeat(), None),
        (
            json!({ "type": "sdk.interrupt_settled", "ok": true }),
            Some(TurnFact::InterruptSettled {
                stop_id: None,
                ok: true,
                still_queued: None,
            }),
        ),
        (
            json!({ "type": "sdk.interrupt_settled", "stopId": "s-1", "ok": true, "stillQueued": ["u"] }),
            Some(TurnFact::InterruptSettled {
                stop_id: Some("s-1".into()),
                ok: true,
                still_queued: Some(vec!["u".into()]),
            }),
        ),
        (json!({ "type": "sdk.send.rejected", "uuid": "u" }), None),
        (json!({ "type": "sdk.turn.complete", "at": 1 }), None),
        (
            json!({ "type": "sdk.stream", "event": {}, "parentToolUseId": "t" }),
            None,
        ),
    ];
    for (line, expected) in facts {
        assert_eq!(TurnFact::from_line(&line), expected, "{line}");
    }
}

// ── property tests ───────────────────────────────────────────────────────────

/// SplitMix64: a small seeded generator, so every failing interleaving can be
/// replayed from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SimTurn {
    /// Streamed text: a send pushed now queues as its own turn.
    Text,
    /// A tool call: a send pushed while it runs is absorbed into the turn.
    Tool,
    /// `/compact`.
    Compact,
}

#[derive(Clone, Debug)]
struct SimCommand {
    uuid: String,
    kind: SimTurn,
}

/// One step of the CLI's current turn.
enum Step {
    Frame(Value),
    /// The tool call starts: commands the CLI reads now are absorbed.
    OpenTool,
    /// The tool result: every absorbed command replays and starts.
    CloseTool,
    /// The result: the turn ends.
    Result,
    /// The absorbed commands' `completed` (before or after the result).
    CompleteAbsorbed,
}

/// The CLI as T8-T10 describe it. `lifecycle: false` is an older CLI: no
/// command lifecycle, no session state, no capability on the init, and (so the
/// head fallback can attribute every result) no absorption and no turns of its
/// own; it replays most sends (an unknown slash command is never replayed, T8).
struct CliModel {
    lifecycle: bool,
    /// Sends the server wrote that the CLI has not read yet.
    pipe: VecDeque<SimCommand>,
    /// Commands the CLI read and has not started.
    queue: VecDeque<SimCommand>,
    /// The CLI announced `running` and not yet `idle`.
    running: bool,
    /// The CLI's `running` announced work no result has ended yet: the CLI
    /// says it is working even when it then drops the command it read.
    state_open: bool,
    /// A turn started and its result is not out yet.
    in_turn: bool,
    current: Option<SimCommand>,
    absorbing: bool,
    absorbed: Vec<SimCommand>,
    script: VecDeque<Step>,
    results: usize,
    /// The current turn's command was replayed.
    replayed: bool,
    /// Results of an old CLI's turns whose command was never replayed: the
    /// head fallback settles them.
    unreplayed_results: usize,
}

impl CliModel {
    fn new(lifecycle: bool) -> Self {
        Self {
            lifecycle,
            pipe: VecDeque::new(),
            queue: VecDeque::new(),
            running: false,
            state_open: false,
            in_turn: false,
            current: None,
            absorbing: false,
            absorbed: Vec::new(),
            script: VecDeque::new(),
            results: 0,
            replayed: false,
            unreplayed_results: 0,
        }
    }

    /// The CLI owes the server work: a send it has not read, a command it has
    /// not started, a turn whose result is not out, or a `running` no result
    /// or idle has answered.
    fn owes(&self) -> bool {
        !self.pipe.is_empty() || !self.queue.is_empty() || self.in_turn || self.state_open
    }

    fn idle(&self) -> bool {
        !self.owes() && self.script.is_empty() && !self.running
    }

    fn lifecycle_frame(&self, uuid: &str, state: &str) -> Option<Value> {
        self.lifecycle.then(|| command(uuid, state))
    }

    fn init_frame(&self) -> Value {
        if self.lifecycle {
            init()
        } else {
            init_without_lifecycle()
        }
    }

    /// The CLI reads one send off its stdin.
    fn read(&mut self) -> Vec<Value> {
        let cmd = self.pipe.pop_front().expect("a send to read");
        let mut frames = Vec::new();
        if self.lifecycle && !self.running {
            frames.push(session_state("running"));
            self.state_open = true;
        }
        self.running = true;
        frames.extend(self.lifecycle_frame(&cmd.uuid, "queued"));
        if self.absorbing {
            self.absorbed.push(cmd);
        } else {
            self.queue.push_back(cmd);
        }
        frames
    }

    /// Start the next queued command's turn, or announce the idle.
    fn start_next(&mut self, rng: &mut Rng) -> Vec<Value> {
        if let Some(cmd) = self.queue.pop_front() {
            self.in_turn = true;
            self.replayed = self.lifecycle || rng.chance(70);
            self.script = self.turn_script(&cmd, rng);
            self.current = Some(cmd);
            return Vec::new();
        }
        if self.running {
            self.running = false;
            self.state_open = false;
            if self.lifecycle {
                return vec![session_state("idle")];
            }
        }
        Vec::new()
    }

    /// A background task finished while the CLI was idle: it starts a turn of
    /// its own, with no uuid and no lifecycle (T19).
    fn start_cli_turn(&mut self) -> Vec<Value> {
        self.running = true;
        self.state_open = true;
        self.in_turn = true;
        self.current = None;
        self.replayed = true;
        self.script = VecDeque::from([
            Step::Frame(self.init_frame()),
            Step::Frame(requesting()),
            Step::Frame(stream()),
            Step::Frame(assistant()),
            Step::Result,
        ]);
        vec![session_state("running")]
    }

    fn turn_script(&self, cmd: &SimCommand, rng: &mut Rng) -> VecDeque<Step> {
        let mut steps = VecDeque::new();
        let started = self.lifecycle_frame(&cmd.uuid, "started");
        // The sidecar reports a replay of a sent uuid on any CLI.
        let replayed = self.replayed.then(|| command(&cmd.uuid, "replayed"));
        let replay_first = rng.chance(30);
        if replay_first {
            steps.extend(replayed.clone().map(Step::Frame));
        }
        steps.extend(started.map(Step::Frame));
        match cmd.kind {
            SimTurn::Compact => {
                steps.push_back(Step::Frame(compacting()));
                steps.push_back(Step::Frame(status_ended()));
                if rng.chance(50) {
                    steps.push_back(Step::Frame(boundary()));
                }
                steps.push_back(Step::Frame(self.init_frame()));
                steps.push_back(Step::Frame(assistant()));
                if !replay_first {
                    steps.extend(replayed.map(Step::Frame));
                }
            }
            SimTurn::Text | SimTurn::Tool => {
                steps.push_back(Step::Frame(self.init_frame()));
                steps.push_back(Step::Frame(requesting()));
                if !replay_first {
                    steps.extend(replayed.map(Step::Frame));
                }
                steps.push_back(Step::Frame(stream()));
                if rng.chance(15) {
                    // An automatic compaction inside the turn.
                    steps.push_back(Step::Frame(compacting()));
                    steps.push_back(Step::Frame(boundary()));
                    steps.push_back(Step::Frame(status_ended()));
                }
                steps.push_back(Step::Frame(assistant()));
                if cmd.kind == SimTurn::Tool && self.lifecycle {
                    steps.push_back(Step::OpenTool);
                    steps.push_back(Step::Frame(heartbeat()));
                    steps.push_back(Step::CloseTool);
                    steps.push_back(Step::Frame(requesting()));
                    steps.push_back(Step::Frame(stream()));
                    steps.push_back(Step::Frame(assistant()));
                }
            }
        }
        let absorbed_after = rng.chance(30);
        if !absorbed_after {
            steps.push_back(Step::CompleteAbsorbed);
        }
        steps.push_back(Step::Result);
        if absorbed_after {
            steps.push_back(Step::CompleteAbsorbed);
        }
        let end = if rng.chance(20) {
            "cancelled"
        } else {
            "completed"
        };
        steps.extend(self.lifecycle_frame(&cmd.uuid, end).map(Step::Frame));
        steps
    }

    /// The CLI's next frames: its current turn's next step, else the next turn
    /// (or the idle).
    fn advance(&mut self, rng: &mut Rng) -> Vec<Value> {
        let Some(step) = self.script.pop_front() else {
            return self.start_next(rng);
        };
        match step {
            Step::Frame(frame) => vec![frame],
            Step::OpenTool => {
                self.absorbing = true;
                Vec::new()
            }
            Step::CloseTool => {
                self.absorbing = false;
                let mut frames = Vec::new();
                for cmd in &self.absorbed {
                    if rng.chance(50) {
                        frames.push(command(&cmd.uuid, "replayed"));
                        frames.push(command(&cmd.uuid, "started"));
                    } else {
                        frames.push(command(&cmd.uuid, "started"));
                        frames.push(command(&cmd.uuid, "replayed"));
                    }
                }
                frames
            }
            Step::CompleteAbsorbed => {
                let absorbed = std::mem::take(&mut self.absorbed);
                // A tool that closed with the result still open keeps its
                // absorbed commands in the turn until here.
                absorbed
                    .iter()
                    .map(|cmd| command(&cmd.uuid, "completed"))
                    .collect()
            }
            Step::Result => {
                self.in_turn = false;
                self.state_open = false;
                self.results += 1;
                if !self.replayed {
                    self.unreplayed_results += 1;
                }
                self.current = None;
                let subtype = if rng.chance(15) {
                    "error_during_execution"
                } else {
                    "success"
                };
                vec![result(subtype)]
            }
        }
    }

    /// The CLI drops a queued command it has not started (`discarded`).
    fn discard(&mut self, rng: &mut Rng) -> Vec<Value> {
        let at = rng.below(self.queue.len());
        let cmd = self.queue.remove(at).expect("a queued command");
        vec![command(&cmd.uuid, "discarded")]
    }
}

/// Feed `frames` to the ledger one by one, holding the invariant after each:
/// the ledger is busy exactly when the CLI owes work, and only a result
/// settles.
fn deliver(
    ledger: &mut ClaudeTurnLedger,
    cli: &CliModel,
    frames: Vec<Value>,
    seen: &mut Seen,
    seed: u64,
) {
    for frame in frames {
        let is_result = frame["type"] == "sdk.result";
        let fact = TurnFact::from_line(&frame);
        let folded = fact.as_ref().map(|fact| ledger.fold(fact));
        match folded {
            Some(Folded::Settled(settlement)) => {
                assert!(is_result, "seed {seed}: only a result settles ({frame})");
                seen.settlements += 1;
                for command in settlement.retired {
                    assert!(
                        seen.retired.insert(command.uuid.clone()),
                        "seed {seed}: {} was settled twice",
                        command.uuid
                    );
                }
                if settlement.head_retired {
                    seen.head_retires += 1;
                }
            }
            _ => assert!(!is_result, "seed {seed}: a result always settles"),
        }
        assert_eq!(
            ledger.busy(),
            cli.owes(),
            "seed {seed}: after {frame} the ledger is busy exactly when the CLI owes work \
             (outstanding {:?}, pipe {}, queue {}, in turn {})",
            ledger.outstanding().collect::<Vec<_>>(),
            cli.pipe.len(),
            cli.queue.len(),
            cli.in_turn,
        );
    }
}

#[derive(Default)]
struct Seen {
    settlements: usize,
    retired: HashSet<String>,
    head_retires: usize,
}

/// Run one random interleaving of sends and CLI frames to quiescence.
fn run_interleaving(seed: u64, lifecycle: bool) {
    let mut rng = Rng(seed);
    let mut cli = CliModel::new(lifecycle);
    let mut ledger = ClaudeTurnLedger::default();
    let mut seen = Seen::default();
    let mut sends_left = 1 + rng.below(6);
    let mut cli_turns_left = if lifecycle { rng.below(3) } else { 0 };
    let mut armed = 0usize;
    let mut steps = 0;
    loop {
        steps += 1;
        assert!(steps < 10_000, "seed {seed}: the run never settled");
        // The actions open now, picked at random.
        let mut actions = Vec::new();
        if sends_left > 0 {
            actions.push(0);
        }
        if !cli.pipe.is_empty() {
            actions.push(1);
        }
        if !cli.script.is_empty() || !cli.queue.is_empty() || cli.running {
            actions.push(2);
        }
        if cli_turns_left > 0 && cli.idle() {
            actions.push(3);
        }
        if lifecycle && !cli.queue.is_empty() && rng.chance(10) {
            actions.push(4);
        }
        if actions.is_empty() {
            break;
        }
        let frames = match actions[rng.below(actions.len())] {
            0 => {
                sends_left -= 1;
                armed += 1;
                let uuid = format!("cmd-{armed}");
                let kind = match rng.below(5) {
                    0 => SimTurn::Compact,
                    1 | 2 if lifecycle => SimTurn::Tool,
                    _ => SimTurn::Text,
                };
                let send_kind = if kind == SimTurn::Compact {
                    SendKind::Compact
                } else {
                    SendKind::Turn
                };
                // The handler arms before it writes.
                ledger.arm(uuid.clone(), Some(format!("r-{uuid}")), send_kind);
                cli.pipe.push_back(SimCommand { uuid, kind });
                Vec::new()
            }
            1 => cli.read(),
            2 => cli.advance(&mut rng),
            3 => {
                cli_turns_left -= 1;
                cli.start_cli_turn()
            }
            _ => cli.discard(&mut rng),
        };
        deliver(&mut ledger, &cli, frames, &mut seen, seed);
        assert_eq!(ledger.busy(), cli.owes(), "seed {seed}: after an action");
    }
    assert!(cli.idle(), "seed {seed}: the CLI ended idle");
    assert!(
        !ledger.busy(),
        "seed {seed}: the ledger ends idle with the CLI"
    );
    assert_eq!(
        ledger.effective_status(false, false),
        EffectiveStatus::Idle,
        "seed {seed}"
    );
    assert_eq!(
        seen.settlements, cli.results,
        "seed {seed}: one settlement per result"
    );
    if lifecycle {
        assert_eq!(
            seen.head_retires, 0,
            "seed {seed}: no fallback with lifecycle"
        );
    } else {
        assert_eq!(
            seen.head_retires, cli.unreplayed_results,
            "seed {seed}: an old CLI settles a result with no replayed command by the head fallback"
        );
        assert_eq!(
            seen.retired.len(),
            armed,
            "seed {seed}: every send settled once"
        );
    }
}

/// Random interleavings consistent with T8-T10 (sends racing the CLI's frames,
/// absorbed and queued sends, compacts, automatic compactions, discards,
/// aborted results, CLI-initiated turns, replays before or after `started`,
/// absorbed completions before or after the result): the ledger is busy
/// exactly while the CLI owes work, ends idle exactly when the CLI is idle,
/// and settles each result exactly once, never retiring a command twice.
#[test]
fn random_interleavings_end_idle_exactly_when_the_cli_is_idle() {
    for seed in 0..4_000 {
        run_interleaving(seed, true);
    }
}

/// The same for an older CLI without lifecycle frames: a replayed command
/// settles at its result, and the head fallback settles a result whose command
/// was never replayed with the oldest armed command.
#[test]
fn random_interleavings_on_an_old_cli_settle_by_the_head_fallback() {
    for seed in 0..2_000 {
        run_interleaving(seed, false);
    }
}
