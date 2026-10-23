//! The Stop latch and the result verdict (design §5.3, §5.4, §11.2; C18).
//!
//! A Stop targets one thing: the running turn's commands, else the oldest
//! command the CLI has not started, else a turn the CLI runs by itself. A Stop
//! that landed on its target is silent; every other turn end rings. A Stop
//! that missed a command the CLI was still starting (T13) is sent again once
//! that command runs, whichever receipt shape the CLI returned:
//!
//! - case A: the receipt lists the command, or came before any of its
//!   lifecycle: re-send once both the receipt and its start have been seen;
//! - case B: the receipt is `[]` and came after the command's lifecycle (the
//!   interrupt may have landed on it): re-send on its first content.

use serde_json::{json, Value};

use super::*;

fn command(uuid: &str, state: &str) -> Value {
    json!({ "type": "sdk.command", "sessionId": "s", "uuid": uuid, "state": state })
}

fn session_state(state: &str) -> Value {
    json!({ "type": "sdk.session.state", "sessionId": "s", "state": state })
}

fn assistant() -> Value {
    json!({ "type": "sdk.assistant", "sessionId": "s", "content": [{ "type": "text", "text": "ok" }] })
}

fn subagent_stream() -> Value {
    json!({ "type": "sdk.stream", "sessionId": "s", "event": {}, "parentToolUseId": "toolu_1" })
}

fn receipt(stop_id: &str, still_queued: &[&str]) -> Value {
    json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "stopId": stop_id, "ok": true, "stillQueued": still_queued })
}

fn refused(stop_id: &str) -> Value {
    json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "stopId": stop_id, "ok": false, "message": "no" })
}

/// The pinned CLI's result for a turn a Stop landed on (T11).
fn aborted() -> Value {
    json!({
        "type": "sdk.result", "sessionId": "s", "subtype": "error_during_execution",
        "isError": true, "terminalReason": "aborted_streaming", "numTurns": 2,
    })
}

fn success() -> Value {
    json!({
        "type": "sdk.result", "sessionId": "s", "subtype": "success", "isError": false,
        "terminalReason": "completed", "numTurns": 1,
    })
}

/// One ledger driven like the stdout consumer drives it, keeping what each
/// fold asked for: the re-sent interrupts and each result's verdict.
#[derive(Default)]
struct Run {
    ledger: ClaudeTurnLedger,
    reissues: Vec<StopReissue>,
    verdicts: Vec<ResultVerdict>,
    refusals: Vec<String>,
}

impl Run {
    fn arm(&mut self, uuid: &str) -> &mut Self {
        self.ledger
            .arm(uuid.into(), Some(format!("request-{uuid}")), SendKind::Turn);
        self
    }

    fn feed(&mut self, line: Value) -> &mut Self {
        // A line the ledger does not fold (a subagent's stream) changes nothing.
        let Some(fact) = TurnFact::from_line(&line) else {
            return self;
        };
        match self.ledger.fold(&fact) {
            Folded::Settled(settlement) => self.verdicts.push(settlement.verdict),
            Folded::Reissue(reissue) => self.reissues.push(reissue),
            Folded::StopRefused { stop_id } => self.refusals.push(stop_id),
            Folded::Applied | Folded::UnknownCommand => {}
        }
        self
    }

    fn feed_all(&mut self, lines: impl IntoIterator<Item = Value>) -> &mut Self {
        for line in lines {
            self.feed(line);
        }
        self
    }

    fn stop(&mut self, stop_id: &str) -> Option<StopArmed> {
        self.ledger.stop(stop_id.to_string())
    }

    fn running(&mut self, uuid: &str) -> &mut Self {
        self.arm(uuid).feed_all([
            session_state("running"),
            command(uuid, "queued"),
            command(uuid, "started"),
            command(uuid, "replayed"),
            assistant(),
        ])
    }
}

// ── target selection ─────────────────────────────────────────────────────────

#[test]
fn an_idle_session_has_nothing_to_stop() {
    let mut run = Run::default();
    assert_eq!(run.stop("stop-1"), None, "an idle Stop is a no-op");
    assert!(!run.ledger.stop_latched());
    // Nothing armed, so the next turn's result rings.
    run.running("u").feed(aborted());
    assert!(matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]));
}

#[test]
fn a_stop_targets_the_running_turns_commands() {
    let mut run = Run::default();
    run.running("a");
    // b is queued behind a: another device's message.
    run.arm("b").feed(command("b", "queued"));
    let armed = run.stop("stop-1").expect("armed");
    assert_eq!(armed.target, StopTargetKind::Running);
    assert_eq!(armed.commands, vec!["a".to_string()]);
}

#[test]
fn a_stop_with_nothing_started_targets_the_oldest_command_not_started() {
    let mut run = Run::default();
    run.arm("a").arm("b").feed(command("a", "queued"));
    let armed = run.stop("stop-1").expect("armed");
    assert_eq!(armed.target, StopTargetKind::NotStarted);
    assert_eq!(armed.commands, vec!["a".to_string()]);
}

#[test]
fn a_stop_with_no_command_targets_the_turn_the_cli_runs_by_itself() {
    let mut run = Run::default();
    run.feed_all([session_state("running"), assistant()]);
    let armed = run.stop("stop-1").expect("armed");
    assert_eq!(armed.target, StopTargetKind::CliTurn);
    assert!(armed.commands.is_empty());
    run.feed(aborted());
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
    run.feed_all([session_state("running"), assistant(), success()]);
    assert!(
        matches!(run.verdicts[1], ResultVerdict::Completed { .. }),
        "the latch cleared at the stopped turn's result: {:?}",
        run.verdicts
    );
}

// ── the result verdict (§5.3) ────────────────────────────────────────────────

#[test]
fn a_warm_stop_that_landed_is_silent() {
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed_all([receipt("stop-1", &[]), aborted(), command("u", "cancelled")]);
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
    assert!(
        run.reissues.is_empty(),
        "a running turn is never re-stopped"
    );
    assert!(
        !run.ledger.stop_latched(),
        "the latch cleared at the result"
    );
}

#[test]
fn a_stop_racing_completion_rings() {
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed_all([receipt("stop-1", &[]), success()]);
    assert_eq!(
        run.verdicts,
        vec![ResultVerdict::Completed { is_error: false }]
    );
    assert!(!run.ledger.stop_latched());
}

#[test]
fn a_queued_command_another_device_sent_runs_and_rings_after_the_stopped_turn() {
    let mut run = Run::default();
    run.running("a");
    run.arm("b").feed(command("b", "queued"));
    run.stop("stop-1").expect("armed");
    run.feed_all([
        receipt("stop-1", &["b"]),
        aborted(),
        command("a", "cancelled"),
        command("b", "started"),
        command("b", "replayed"),
        assistant(),
        success(),
    ]);
    assert_eq!(
        run.verdicts,
        vec![
            ResultVerdict::Silent,
            ResultVerdict::Completed { is_error: false }
        ]
    );
    assert!(run.reissues.is_empty(), "b is not the Stop's target");
}

/// A Stop that did not land (the turn failed on its own first) silences
/// nothing: the failed turn rings with its banner.
#[test]
fn a_failed_turn_under_a_stop_that_missed_rings() {
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed_all([
        receipt("stop-1", &[]),
        json!({
            "type": "sdk.result", "sessionId": "s", "subtype": "error_max_turns",
            "isError": true, "numTurns": 4,
        }),
    ]);
    assert!(
        matches!(&run.verdicts[..], [ResultVerdict::Failed { message }] if message.contains("turn limit")),
        "{:?}",
        run.verdicts
    );
}

#[test]
fn an_aborted_result_with_no_stop_rings_with_a_banner() {
    let mut run = Run::default();
    run.running("u").feed(aborted());
    assert_eq!(
        run.verdicts,
        vec![ResultVerdict::Failed {
            message: ABORTED_TURN_MESSAGE.to_string()
        }]
    );
}

#[test]
fn a_non_target_command_aborted_by_the_stop_rings() {
    let mut run = Run::default();
    run.running("a");
    run.stop("stop-1").expect("armed");
    // b is absorbed into the stopped turn after the Stop: not a target.
    run.arm("b")
        .feed_all([command("b", "queued"), command("b", "started")]);
    run.feed(aborted());
    assert!(
        matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]),
        "{:?}",
        run.verdicts
    );
}

#[test]
fn an_api_error_result_rings_without_a_banner() {
    let mut run = Run::default();
    run.running("u").feed(json!({
        "type": "sdk.result", "sessionId": "s", "subtype": "success", "isError": true,
        "terminalReason": "api_error", "numTurns": 1,
    }));
    assert_eq!(
        run.verdicts,
        vec![ResultVerdict::Completed { is_error: true }]
    );
    assert_eq!(run.verdicts[0].banner(), None);
    assert_eq!(run.verdicts[0].outcome(), TurnOutcome::Failed);
}

#[test]
fn a_failed_result_rings_with_its_own_text_or_the_copy_for_its_subtype() {
    let mut run = Run::default();
    run.running("a").feed(json!({
        "type": "sdk.result", "sessionId": "s", "subtype": "error_max_turns", "isError": true,
        "terminalReason": "max_turns", "numTurns": 9,
    }));
    run.running("b").feed(json!({
        "type": "sdk.result", "sessionId": "s", "subtype": "error_during_execution", "isError": true,
        "numTurns": 1, "errorText": "The model is overloaded.",
    }));
    run.running("c")
        .feed(json!({ "type": "sdk.result", "sessionId": "s", "subtype": "error_unheard_of" }));
    assert_eq!(
        run.verdicts
            .iter()
            .map(|verdict| verdict.banner().map(str::to_string))
            .collect::<Vec<_>>(),
        vec![
            Some("Claude reached its turn limit. Send a message to continue.".to_string()),
            Some("The model is overloaded.".to_string()),
            Some(DEFAULT_TURN_FAILURE_MESSAGE.to_string()),
        ]
    );
    assert!(run
        .verdicts
        .iter()
        .all(|verdict| verdict.rings() && verdict.outcome() == TurnOutcome::Failed));
}

/// The copy each failed result kind shows when the CLI gave no text of its
/// own (its `[ede_diagnostic]` lines never reach the server).
#[test]
fn the_copy_for_each_failed_result_kind() {
    for (subtype, copy) in [
        (
            "error_max_turns",
            "Claude reached its turn limit. Send a message to continue.",
        ),
        (
            "error_max_budget_usd",
            "Claude reached the configured spending limit.",
        ),
        (
            "error_max_structured_output_retries",
            "Claude could not produce the requested response format.",
        ),
        ("error_during_execution", DEFAULT_TURN_FAILURE_MESSAGE),
    ] {
        let mut run = Run::default();
        run.running("u").feed(json!({
            "type": "sdk.result", "sessionId": "s", "subtype": subtype, "isError": true, "numTurns": 1,
        }));
        assert_eq!(run.verdicts[0].banner(), Some(copy), "{subtype}");
    }
    let mut run = Run::default();
    run.running("u")
        .feed(json!({ "type": "sdk.result", "sessionId": "s", "subtype": "success" }));
    assert_eq!(
        run.verdicts[0].banner(),
        None,
        "a successful result shows no banner"
    );
}

#[test]
fn an_older_cli_reports_a_stopped_turn_without_a_terminal_reason() {
    let older_aborted = || json!({ "type": "sdk.result", "sessionId": "s", "subtype": "error_during_execution", "numTurns": 1 });
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed(older_aborted());
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);

    // With no Stop armed, the same result is a failure; and a boot refusal's
    // result (no turn ran) is never a stopped turn.
    let mut run = Run::default();
    run.running("u").feed(older_aborted());
    assert!(matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]));
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed(json!({ "type": "sdk.result", "sessionId": "s", "subtype": "error_during_execution", "numTurns": 0 }));
    assert!(matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]));
}

#[test]
fn a_protocol_fake_result_names_its_subtype_in_result() {
    let mut run = Run::default();
    run.running("u")
        .feed(json!({ "type": "sdk.result", "sessionId": "s", "result": "success" }));
    assert_eq!(
        run.verdicts,
        vec![ResultVerdict::Completed { is_error: false }]
    );
}

// ── cold Stops: the re-send rule (§5.4) ──────────────────────────────────────

/// Case A, receipt `[]` before any lifecycle (the interrupt overtook the
/// command): re-sent at its start, and the aborted result is silent.
#[test]
fn case_a_a_receipt_before_the_commands_lifecycle_re_sends_at_its_start() {
    let mut run = Run::default();
    run.arm("u");
    let armed = run.stop("stop-1").expect("armed");
    assert_eq!(armed.target, StopTargetKind::NotStarted);
    run.feed_all([
        receipt("stop-1", &[]),
        session_state("running"),
        command("u", "queued"),
    ]);
    assert!(run.reissues.is_empty(), "nothing to stop before it starts");
    run.feed(command("u", "started"));
    assert_eq!(run.reissues.len(), 1, "{:?}", run.reissues);
    let reissue = &run.reissues[0];
    assert_eq!(reissue.stop_id, "stop-1");
    assert_eq!(reissue.case, ReissueCase::A);
    assert_eq!(reissue.target, "u");
    assert_eq!(reissue.reissues, 1);
    assert_ne!(reissue.reissue_id, "stop-1", "the re-send has its own id");
    run.feed_all([command("u", "replayed"), assistant(), aborted()]);
    assert_eq!(run.reissues.len(), 1, "one re-send");
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
}

/// Case A, receipt `[uuid]` (the command was queued): re-sent at its start,
/// whether the start comes after the receipt or before it.
#[test]
fn case_a_a_receipt_listing_the_command_re_sends_once_both_are_seen() {
    let mut start_after = Run::default();
    start_after
        .arm("u")
        .feed_all([session_state("running"), command("u", "queued")]);
    start_after.stop("stop-1").expect("armed");
    start_after.feed(receipt("stop-1", &["u"]));
    assert!(start_after.reissues.is_empty());
    start_after.feed(command("u", "started"));
    assert_eq!(start_after.reissues.len(), 1);
    assert_eq!(start_after.reissues[0].case, ReissueCase::A);

    let mut start_before = Run::default();
    start_before
        .arm("u")
        .feed_all([session_state("running"), command("u", "queued")]);
    start_before.stop("stop-1").expect("armed");
    start_before.feed(command("u", "started"));
    assert!(start_before.reissues.is_empty(), "no receipt yet");
    start_before.feed(receipt("stop-1", &["u"]));
    assert_eq!(start_before.reissues.len(), 1, "re-sent at the receipt");
    assert_eq!(start_before.reissues[0].case, ReissueCase::A);
    start_before.feed(aborted());
    assert_eq!(start_before.verdicts, vec![ResultVerdict::Silent]);
}

/// Case B, receipt `[]` after the command's queued and started: the interrupt
/// may have landed on it, so the re-send waits for its first content.
#[test]
fn case_b_an_empty_receipt_after_the_lifecycle_re_sends_on_first_content() {
    let mut run = Run::default();
    run.arm("u")
        .feed_all([session_state("running"), command("u", "queued")]);
    run.stop("stop-1").expect("armed");
    run.feed_all([command("u", "started"), receipt("stop-1", &[])]);
    assert!(run.reissues.is_empty(), "the Stop may have landed");
    run.feed(command("u", "replayed"));
    assert_eq!(run.reissues.len(), 1);
    assert_eq!(run.reissues[0].case, ReissueCase::B);
    run.feed_all([assistant(), aborted()]);
    assert_eq!(run.reissues.len(), 1);
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
}

/// Case B's first content can also be the turn's own assistant or stream
/// frame (an older CLI that replays nothing), but never a subagent's.
#[test]
fn case_b_first_content_is_the_turns_own_assistant_frame() {
    let mut run = Run::default();
    run.arm("u")
        .feed_all([session_state("running"), command("u", "queued")]);
    run.stop("stop-1").expect("armed");
    run.feed_all([
        command("u", "started"),
        receipt("stop-1", &[]),
        subagent_stream(),
    ]);
    assert!(
        run.reissues.is_empty(),
        "a subagent's output is not the turn's"
    );
    run.feed(assistant());
    assert_eq!(run.reissues.len(), 1);
    assert_eq!(run.reissues[0].case, ReissueCase::B);
}

/// Case B, the landed Stop: the command settles before any content, so
/// nothing is re-sent and its aborted result is silent.
#[test]
fn case_b_a_stop_that_landed_is_never_re_sent() {
    let mut run = Run::default();
    run.arm("u")
        .feed_all([session_state("running"), command("u", "queued")]);
    run.stop("stop-1").expect("armed");
    run.feed_all([
        command("u", "started"),
        receipt("stop-1", &[]),
        aborted(),
        command("u", "cancelled"),
        session_state("idle"),
    ]);
    assert!(run.reissues.is_empty());
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
}

/// A command that ran to success before the re-send could land rings: the
/// user believes it stopped, and it did not.
#[test]
fn a_cold_stop_whose_command_finished_first_rings() {
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.feed_all([
        receipt("stop-1", &[]),
        session_state("running"),
        command("u", "queued"),
        command("u", "started"),
        command("u", "replayed"),
        assistant(),
        success(),
    ]);
    assert_eq!(run.reissues.len(), 1);
    assert_eq!(
        run.verdicts,
        vec![ResultVerdict::Completed { is_error: false }]
    );
}

/// A Stop re-sends at most once: the re-send ends its wait, so the command's
/// later lifecycle and content send nothing more.
#[test]
fn a_stop_re_sends_at_most_once() {
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.feed_all([receipt("stop-1", &[]), command("u", "started")]);
    assert_eq!(run.reissues.len(), 1);
    run.feed_all([
        command("u", "replayed"),
        assistant(),
        command("u", "started"),
        receipt("stop-1", &[]),
    ]);
    assert_eq!(run.reissues.len(), 1, "{:?}", run.reissues);
    assert!(run.reissues[0].reissues <= MAX_STOP_REISSUES);
}

/// The receipt of a re-sent interrupt, or of an earlier Stop, is not the
/// latch's own receipt.
#[test]
fn only_the_latchs_own_receipt_is_read() {
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.feed(receipt("stop-0", &["u"]));
    run.feed(command("u", "started"));
    assert!(run.reissues.is_empty(), "a foreign receipt was read");
}

/// A protocol fake echoes no stop id: its receipt is the latch's.
#[test]
fn a_receipt_without_a_stop_id_is_the_pending_latchs() {
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.feed(json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "ok": true }));
    run.feed(command("u", "started"));
    assert_eq!(run.reissues.len(), 1);
}

/// An older CLI with no command lifecycle: a Stop before its replay waits for
/// the replay to re-send; a stopped turn's result settles by the head fallback
/// and is silent.
#[test]
fn an_older_cli_with_no_lifecycle() {
    let mut run = Run::default();
    run.arm("u");
    let armed = run.stop("stop-1").expect("armed");
    assert_eq!(armed.target, StopTargetKind::NotStarted);
    run.feed(json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "stopId": "stop-1", "ok": true }));
    run.feed(command("u", "replayed"));
    assert_eq!(run.reissues.len(), 1, "the replay is its start");
    run.feed(aborted());
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);

    let mut landed = Run::default();
    landed.arm("u");
    landed.stop("stop-1").expect("armed");
    landed.feed_all([
        json!({ "type": "sdk.interrupt_settled", "sessionId": "s", "ok": true }),
        json!({ "type": "sdk.status", "sessionId": "s", "status": "running" }),
        aborted(),
    ]);
    assert!(landed.reissues.is_empty());
    assert_eq!(landed.verdicts, vec![ResultVerdict::Silent]);
}

// ── disarming and clearing ───────────────────────────────────────────────────

#[test]
fn a_refused_interrupt_disarms_the_latch() {
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed(refused("stop-1"));
    assert_eq!(run.refusals, vec!["stop-1".to_string()]);
    assert!(!run.ledger.stop_latched());
    run.feed(aborted());
    assert!(
        matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]),
        "the turn kept running, so its end rings: {:?}",
        run.verdicts
    );
}

#[test]
fn an_interrupt_that_could_not_be_written_disarms_the_latch() {
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.ledger.stop_unsent("stop-1");
    assert!(!run.ledger.stop_latched());
    run.ledger.stop_unsent("stop-0");
    run.feed(aborted());
    assert!(matches!(run.verdicts[..], [ResultVerdict::Failed { .. }]));
}

#[test]
fn the_latch_clears_when_its_targets_end() {
    // A terminal lifecycle of the target.
    let mut run = Run::default();
    run.arm("u").feed(command("u", "queued"));
    run.stop("stop-1").expect("armed");
    run.feed(command("u", "discarded"));
    assert!(!run.ledger.stop_latched());

    // An idle retires the started target.
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    run.feed(session_state("idle"));
    assert!(!run.ledger.stop_latched());

    // An idle keeps a target the CLI has not reported (it can race the idle).
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.feed(session_state("idle"));
    assert!(run.ledger.stop_latched());

    // The end of output.
    let mut run = Run::default();
    run.running("u");
    run.stop("stop-1").expect("armed");
    assert!(run.ledger.eof());
    assert!(!run.ledger.stop_latched());

    // A taken-back send.
    let mut run = Run::default();
    run.arm("u");
    run.stop("stop-1").expect("armed");
    run.ledger.undo_arm("u");
    assert!(!run.ledger.stop_latched());
}

/// A stale latch never silences a later turn: the result after the target's
/// end rings.
#[test]
fn a_cleared_latch_never_silences_the_next_turn() {
    let mut run = Run::default();
    run.running("a");
    run.stop("stop-1").expect("armed");
    run.feed_all([receipt("stop-1", &[]), aborted(), command("a", "cancelled")]);
    run.running("b").feed(aborted());
    assert_eq!(run.verdicts.len(), 2);
    assert_eq!(run.verdicts[0], ResultVerdict::Silent);
    assert!(
        matches!(run.verdicts[1], ResultVerdict::Failed { .. }),
        "{:?}",
        run.verdicts
    );
}

/// A second Stop before the first one's receipt keeps the first one's
/// targets: everything the user stopped stays silent.
#[test]
fn a_second_stop_keeps_the_first_ones_targets() {
    let mut run = Run::default();
    run.running("a");
    run.stop("stop-1").expect("armed");
    run.arm("b")
        .feed_all([command("b", "queued"), command("b", "started")]);
    let second = run.stop("stop-2").expect("armed");
    assert_eq!(second.commands, vec!["a".to_string(), "b".to_string()]);
    run.feed_all([receipt("stop-1", &[]), receipt("stop-2", &[]), aborted()]);
    assert_eq!(run.verdicts, vec![ResultVerdict::Silent]);
}
