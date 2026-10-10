//! Unit rows: the terminal row of a coding-agent pane whose screen is one
//! member of a contained unit. The registry spawns the screen through the
//! unit's placement, hands every unrequested screen exit to the unit
//! lifecycle instead of publishing it, publishes `terminal.exit` only when the
//! unit ends (`complete_unit_end`), and can start a new screen in the same row.
//!
//! Linux only: every process a test signals is pinned by pid and start time
//! through `/proc`, so a signal never reaches a recycled pid.
use super::tests::collector;
use super::*;
use std::time::{Duration, Instant};

fn bash(script: &str) -> SpawnSpec {
    SpawnSpec {
        program: "bash".into(),
        args: vec!["-c".into(), script.into()],
        env_overrides: Default::default(),
        cwd: None,
        cols: 80,
        rows: 24,
    }
}

fn env() -> BTreeMap<String, String> {
    std::env::vars()
        .filter(|(k, _)| k == "PATH" || k == "HOME")
        .collect()
}

fn placement(wrapper: Option<Vec<String>>) -> UnitPlacement {
    UnitPlacement {
        unit_id: "u1".into(),
        wrapper,
        env: vec![("FRESHELL_UNIT_ID".into(), "u1".into())],
        main_is_screen: true,
    }
}

fn attach_collector(reg: &TerminalRegistry, tid: &str) -> Arc<Mutex<Vec<ServerMessage>>> {
    let (sink, seen) = collector();
    let _ = reg.attach(
        tid,
        1,
        sink,
        Some("a".into()),
        0,
        false,
        false,
        None,
        None,
        None,
        PacedAttachOptions::default(),
    );
    seen
}

/// Records every screen exit the registry hands to the unit lifecycle.
fn record_screen_exits(reg: &TerminalRegistry) -> Arc<Mutex<Vec<UnitScreenExit>>> {
    let got: Arc<Mutex<Vec<UnitScreenExit>>> = Arc::default();
    let g = got.clone();
    reg.set_unit_screen_exit_hook(Arc::new(move |e| g.lock().unwrap().push(e)));
    got
}

fn wait(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Waits until the row's reader has taken its screen's exit (the registry
/// marks the screen's PTY reaped, so its pid is gone), then lets anything
/// that exit would publish land: it is published in the same reader call.
fn screen_exit_handled(reg: &TerminalRegistry, tid: &str) {
    wait("the reader took the screen exit", || {
        reg.pid_of(tid).is_none()
    });
    std::thread::sleep(Duration::from_millis(200));
}

fn outputs(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> Vec<TerminalOutput> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            ServerMessage::TerminalOutput(o) => Some(o.clone()),
            _ => None,
        })
        .collect()
}

fn output_text(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> String {
    outputs(seen).into_iter().map(|o| o.data).collect()
}

fn exits(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> Vec<i64> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            ServerMessage::TerminalExit(e) => Some(e.exit_code),
            _ => None,
        })
        .collect()
}

fn exit_events(events: &Arc<Mutex<Vec<ActivityEvent>>>, tid: &str) -> Vec<bool> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            ActivityEvent::Exit {
                terminal_id,
                spontaneous,
                ..
            } if terminal_id == tid => Some(*spontaneous),
            _ => None,
        })
        .collect()
}

/// `/proc/<pid>/stat` fields 3 (state) and 22 (start time).
fn stat(pid: u32) -> Option<(char, u64)> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = raw.get(raw.rfind(')')? + 2..)?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some((
        fields.first()?.chars().next()?,
        fields.get(19)?.parse().ok()?,
    ))
}

/// A process this test started, pinned by pid and start time: it is
/// signalled only while that pid still names it, and killed on drop so a
/// failing test leaves nothing running.
struct Own {
    pid: u32,
    start: u64,
}

impl Own {
    fn pin(pid: u32) -> Self {
        let (_, start) = stat(pid).expect("the process runs when it is pinned");
        Own { pid, start }
    }

    fn alive(&self) -> bool {
        matches!(stat(self.pid), Some((state, start)) if start == self.start && state != 'Z')
    }

    fn kill(&self) {
        if stat(self.pid).is_some_and(|(_, start)| start == self.start) {
            // SAFETY: plain kill(2) on a pid whose start time was just
            // checked to still name the process this test started.
            unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
        }
    }
}

impl Drop for Own {
    fn drop(&mut self) {
        self.kill();
    }
}

#[test]
fn a_unit_row_spawns_through_the_wrapper_with_the_unit_env() {
    let reg = TerminalRegistry::new();
    let spec = bash("echo W=$WRAPPED U=$FRESHELL_UNIT_ID; sleep 30");
    let wrapper = Some(vec!["/usr/bin/env".to_string(), "WRAPPED=yes".to_string()]);
    let pid = reg
        .create_in_unit(
            &spec,
            &env(),
            "T1".into(),
            "S1".into(),
            "claude",
            None,
            Some("crq-1"),
            None,
            None,
            placement(wrapper),
        )
        .unwrap();
    let screen = Own::pin(pid);
    let seen = attach_collector(&reg, "T1");
    wait("wrapped output", || {
        output_text(&seen).contains("W=yes U=u1")
    });
    assert_eq!(reg.unit_id_for("T1").as_deref(), Some("u1"));
    assert_eq!(
        reg.terminal_for_create_request("crq-1").as_deref(),
        Some("T1")
    );
    assert_eq!(
        reg.respawn_spec("T1"),
        Some((spec, env())),
        "the row keeps the unwrapped spawn inputs"
    );
    screen.kill();
}

#[test]
fn an_unrequested_screen_exit_goes_to_the_unit_hook_and_publishes_nothing() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    reg.create_in_unit(
        &bash("sleep 0.3; exit 3"),
        &env(),
        "T2".into(),
        "S2".into(),
        "codex",
        None,
        None,
        None,
        None,
        placement(None),
    )
    .unwrap();
    let seen = attach_collector(&reg, "T2");
    wait("hook fired", || !got.lock().unwrap().is_empty());
    let e = got.lock().unwrap()[0].clone();
    assert_eq!(
        (
            e.terminal_id.as_str(),
            e.unit_id.as_str(),
            e.exit_code,
            e.screen_generation
        ),
        ("T2", "u1", 3, 0)
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        exits(&seen).is_empty(),
        "no terminal.exit before the unit decides"
    );
    assert!(
        reg.is_pty_running("T2"),
        "the row stays Running until the unit ends or the screen is replaced"
    );
}

#[test]
fn a_requested_ending_publishes_exit_only_at_complete_unit_end() {
    let reg = TerminalRegistry::new();
    let pid = reg
        .create_in_unit(
            &bash("sleep 30"),
            &env(),
            "T3".into(),
            "S3".into(),
            "codex",
            None,
            None,
            None,
            None,
            placement(None),
        )
        .unwrap();
    let screen = Own::pin(pid);
    let seen = attach_collector(&reg, "T3");
    let rev = reg.revision();
    let before = now_ms();
    assert!(reg.mark_ending("T3", UnitEnding::Requested));
    let after = now_ms();
    let since = reg.ending_since("T3").expect("the mark time is recorded");
    assert!((before..=after).contains(&since));
    assert!(
        !reg.mark_ending("T3", UnitEnding::AgentExited { exit_code: 1 }),
        "first ending wins"
    );
    assert_eq!(reg.ending("T3"), Some(UnitEnding::Requested));
    assert_eq!(reg.ending_since("T3"), Some(since));
    screen.kill(); // the unit's kill, simulated on our own child
    screen_exit_handled(&reg, "T3");
    assert!(exits(&seen).is_empty(), "screen death is not Gone");
    assert!(reg.is_pty_running("T3"), "the row stays Running until Gone");
    assert!(reg.complete_unit_end("T3", UnitEnding::Requested));
    assert_eq!(exits(&seen), vec![0]);
    assert!(!reg.is_running("T3") && reg.revision() > rev);
    assert!(
        !reg.complete_unit_end("T3", UnitEnding::Requested),
        "the row is gone"
    );
}

#[test]
fn an_agent_exit_ending_publishes_a_natural_exit_and_keeps_the_row() {
    let reg = TerminalRegistry::new();
    reg.create_in_unit(
        &bash("sleep 0.2; exit 7"),
        &env(),
        "T4".into(),
        "S4".into(),
        "claude",
        None,
        None,
        None,
        None,
        placement(None),
    )
    .unwrap();
    let seen = attach_collector(&reg, "T4");
    reg.mark_ending("T4", UnitEnding::AgentExited { exit_code: 7 });
    screen_exit_handled(&reg, "T4");
    assert!(exits(&seen).is_empty(), "screen death is not Gone");
    assert!(reg.complete_unit_end("T4", UnitEnding::AgentExited { exit_code: 7 }));
    assert_eq!(exits(&seen), vec![7]);
    let row = reg
        .inventory()
        .into_iter()
        .find(|t| t.terminal_id == "T4")
        .expect("natural-exit rows are retained");
    assert_eq!(row.status, TerminalRunStatus::Exited);
}

#[test]
fn replace_screen_keeps_the_terminal_id_and_its_subscribers() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    reg.create_in_unit(
        &bash("echo FIRST; sleep 0.2; exit 9"),
        &env(),
        "T5".into(),
        "S5".into(),
        "codex",
        None,
        Some("crq-5"),
        None,
        None,
        UnitPlacement {
            main_is_screen: false,
            ..placement(None)
        },
    )
    .unwrap();
    let seen = attach_collector(&reg, "T5");
    wait("first screen exits", || !got.lock().unwrap().is_empty());
    let pid2 = reg
        .replace_screen(
            "T5",
            &bash("echo SECOND; sleep 30"),
            &env(),
            UnitPlacement {
                main_is_screen: false,
                ..placement(None)
            },
        )
        .unwrap();
    let screen = Own::pin(pid2);
    wait("second screen output", || {
        output_text(&seen).contains("SECOND")
    });
    assert!(output_text(&seen).contains("FIRST"));
    assert!(
        exits(&seen).is_empty(),
        "a screen restart is invisible to subscribers"
    );
    assert_eq!(reg.pid_of("T5"), Some(pid2));
    screen.kill();
    wait("second exit hook", || got.lock().unwrap().len() == 2);
    assert_eq!(got.lock().unwrap()[0].screen_generation, 0);
    assert_eq!(got.lock().unwrap()[1].screen_generation, 1);
}

#[test]
fn replace_screen_continues_the_output_sequence_at_the_current_geometry() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    reg.create_in_unit(
        &bash("echo ONE; sleep 0.5; exit 9"),
        &env(),
        "T6".into(),
        "S6".into(),
        "codex",
        None,
        None,
        None,
        None,
        placement(None),
    )
    .unwrap();
    let seen = attach_collector(&reg, "T6");
    wait("first screen output", || output_text(&seen).contains("ONE"));
    reg.resize("T6", 100, 30);
    wait("first screen exits", || !got.lock().unwrap().is_empty());
    let first_last = outputs(&seen)
        .iter()
        .map(|o| o.seq_end)
        .max()
        .expect("the first screen printed");
    let pid = reg
        .replace_screen("T6", &bash("stty size; sleep 30"), &env(), placement(None))
        .unwrap();
    let _screen = Own::pin(pid);
    wait("second screen output", || {
        output_text(&seen).contains("30 100")
    });
    let all = outputs(&seen);
    let second: Vec<&TerminalOutput> = all.iter().filter(|o| o.seq_start > first_last).collect();
    assert_eq!(
        second.first().map(|o| (o.seq_start, o.stream_id.as_str())),
        Some((first_last + 1, "S6")),
        "the new screen's first frame follows the old screen's last one on the same stream"
    );
    assert!(all.iter().all(|o| o.stream_id == "S6"));
}

#[test]
fn screen_restarts_are_capped_per_liveness_window() {
    let reg = TerminalRegistry::new();
    reg.set_respawn_liveness_window_ms(60_000);
    reg.set_respawn_generation_cap(2);
    let got = record_screen_exits(&reg);
    let seen_exits = |n: usize| {
        let got = got.clone();
        move || got.lock().unwrap().len() >= n
    };
    reg.create_in_unit(
        &bash("exit 4"),
        &env(),
        "T7".into(),
        "S7".into(),
        "codex",
        None,
        Some("crq-cap"),
        None,
        None,
        placement(None),
    )
    .unwrap();
    wait("screen 0 exits", seen_exits(1));
    reg.replace_screen("T7", &bash("exit 4"), &env(), placement(None))
        .expect("first quick restart");
    wait("screen 1 exits", seen_exits(2));
    reg.replace_screen("T7", &bash("sleep 0.3; exit 4"), &env(), placement(None))
        .expect("second quick restart");
    let err = reg
        .replace_screen("T7", &bash("exit 4"), &env(), placement(None))
        .expect_err("a third quick restart is over the cap");
    assert_eq!(err.to_string(), "respawn cap");
    assert!(!reg.respawn_exhausted("crq-cap"));
    reg.set_respawn_liveness_window_ms(100);
    wait("screen 2 exits after living 300 ms", seen_exits(3));
    reg.replace_screen("T7", &bash("exit 4"), &env(), placement(None))
        .expect("a screen that outlived the window resets the count");
    assert!(
        !reg.respawn_exhausted("crq-cap"),
        "screen restarts never spend auto-resume's create-request budget"
    );
}

#[test]
fn complete_unit_end_never_waits_for_a_pty_slave_holder() {
    let reg = TerminalRegistry::new();
    // The background `sleep` ignores the hangup, so it outlives the screen
    // and keeps the PTY slave open: the reader never reaches end of stream.
    let pid = reg
        .create_in_unit(
            &bash("trap '' HUP; sleep 30 & echo HOLDER=$!; exit 0"),
            &env(),
            "T8".into(),
            "S8".into(),
            "codex",
            None,
            None,
            None,
            None,
            placement(None),
        )
        .unwrap();
    let screen_start = stat(pid).map(|(_, start)| start);
    let seen = attach_collector(&reg, "T8");
    wait("holder pid printed", || {
        output_text(&seen).contains("HOLDER=") && output_text(&seen).ends_with('\n')
    });
    let text = output_text(&seen);
    let holder_pid: u32 = text
        .split("HOLDER=")
        .nth(1)
        .and_then(|rest| {
            rest.split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()
        })
        .expect("the holder pid");
    let holder = Own::pin(holder_pid);
    wait(
        "the screen itself exited",
        || !matches!(stat(pid), Some((state, start)) if Some(start) == screen_start && state != 'Z'),
    );
    assert!(holder.alive());
    assert!(reg.mark_ending("T8", UnitEnding::Requested));
    let t0 = Instant::now();
    assert!(reg.complete_unit_end("T8", UnitEnding::Requested));
    assert!(
        t0.elapsed() < Duration::from_secs(1),
        "Gone publication waited {:?} for the PTY slave holder",
        t0.elapsed()
    );
    assert_eq!(exits(&seen), vec![0]);
    assert!(holder.alive(), "the slave holder still runs");
    holder.kill();
}

#[test]
fn kill_all_never_publishes_exit_for_unit_rows() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    let pid = reg
        .create_in_unit(
            &bash("sleep 30"),
            &env(),
            "TU".into(),
            "SU".into(),
            "codex",
            None,
            None,
            None,
            None,
            placement(None),
        )
        .unwrap();
    let screen = Own::pin(pid);
    reg.create(
        &bash("sleep 30"),
        &env(),
        "TP".into(),
        "SP".into(),
        "shell",
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let unit_seen = attach_collector(&reg, "TU");
    let plain_seen = attach_collector(&reg, "TP");
    assert_eq!(reg.kill_all(), 2);
    assert_eq!(exits(&plain_seen), vec![0]);
    wait("the unit screen is dead", || !screen.alive());
    screen_exit_handled(&reg, "TU");
    assert!(
        exits(&unit_seen).is_empty(),
        "shutdown leaves Gone to the unit"
    );
    assert!(
        got.lock().unwrap().is_empty(),
        "a requested ending never reaches the unit hook"
    );
    assert_eq!(reg.ending("TU"), Some(UnitEnding::Requested));
    assert!(
        reg.is_running("TU"),
        "the unit row stays until its unit ends"
    );
    assert_eq!(reg.unit_id_for("TP"), None);
}

#[test]
fn the_gone_hook_runs_once_at_complete_unit_end_never_at_a_screen_exit() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    let gone: Arc<Mutex<Vec<i64>>> = Arc::default();
    let g = gone.clone();
    reg.create_in_unit(
        &bash("exit 3"),
        &env(),
        "T10".into(),
        "S10".into(),
        "codex",
        None,
        None,
        None,
        Some(Box::new(move |code| g.lock().unwrap().push(code))),
        placement(None),
    )
    .unwrap();
    wait("first screen exits", || got.lock().unwrap().len() == 1);
    assert!(gone.lock().unwrap().is_empty(), "a screen exit is not Gone");
    let pid = reg
        .replace_screen("T10", &bash("sleep 30"), &env(), placement(None))
        .unwrap();
    let screen = Own::pin(pid);
    assert!(reg.mark_ending("T10", UnitEnding::AgentExited { exit_code: 5 }));
    screen.kill();
    screen_exit_handled(&reg, "T10");
    assert!(gone.lock().unwrap().is_empty());
    assert_eq!(
        got.lock().unwrap().len(),
        1,
        "a marked ending silences the screen exit"
    );
    assert!(reg.complete_unit_end("T10", UnitEnding::AgentExited { exit_code: 5 }));
    assert_eq!(*gone.lock().unwrap(), vec![5]);
    assert!(reg.complete_unit_end("T10", UnitEnding::AgentExited { exit_code: 5 }));
    assert_eq!(*gone.lock().unwrap(), vec![5], "the Gone hook runs once");
}

#[test]
fn a_start_failure_ending_publishes_the_wrapper_code_silently() {
    let reg = TerminalRegistry::new();
    reg.set_respawn_generation_cap(1);
    let events: Arc<Mutex<Vec<ActivityEvent>>> = Arc::default();
    let ev = events.clone();
    reg.set_activity_observer(Arc::new(move |e| ev.lock().unwrap().push(e)));
    let got = record_screen_exits(&reg);
    for (tid, crid) in [("TSF", "crq-sf"), ("TAE", "crq-ae")] {
        reg.create_in_unit(
            &bash("exit 1"),
            &env(),
            tid.into(),
            format!("S-{tid}"),
            "codex",
            None,
            Some(crid),
            None,
            None,
            placement(None),
        )
        .unwrap();
    }
    let sf_seen = attach_collector(&reg, "TSF");
    let ae_seen = attach_collector(&reg, "TAE");
    wait("both screens exit", || got.lock().unwrap().len() == 2);

    assert!(reg.mark_ending("TSF", UnitEnding::StartFailed { exit_code: 1 }));
    assert!(reg.complete_unit_end("TSF", UnitEnding::StartFailed { exit_code: 1 }));
    assert_eq!(exits(&sf_seen), vec![1]);
    assert_eq!(
        reg.inventory()
            .into_iter()
            .find(|t| t.terminal_id == "TSF")
            .map(|t| t.status),
        Some(TerminalRunStatus::Exited)
    );
    assert_eq!(
        exit_events(&events, "TSF"),
        vec![false],
        "a start failure is silent"
    );
    assert!(
        !reg.respawn_exhausted("crq-sf"),
        "a start failure is never a crash"
    );

    // Control: the same exit ended as the agent's own exit is a crash.
    assert!(reg.mark_ending("TAE", UnitEnding::AgentExited { exit_code: 1 }));
    assert!(reg.complete_unit_end("TAE", UnitEnding::AgentExited { exit_code: 1 }));
    assert_eq!(exits(&ae_seen), vec![1]);
    assert_eq!(exit_events(&events, "TAE"), vec![true]);
    assert!(reg.respawn_exhausted("crq-ae"));
}

#[test]
fn a_replaced_screens_late_exit_never_touches_the_new_screen() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    let first = reg
        .create_in_unit(
            &bash("sleep 30"),
            &env(),
            "T12".into(),
            "S12".into(),
            "codex",
            None,
            None,
            None,
            None,
            placement(None),
        )
        .unwrap();
    let first = Own::pin(first);
    let second = reg
        .replace_screen("T12", &bash("sleep 30"), &env(), placement(None))
        .unwrap();
    let second = Own::pin(second);
    assert!(first.alive(), "a replacement never signals the old screen");
    first.kill(); // ended later, as the unit's stop would
    wait("the replaced screen is ended", || !first.alive());
    // The replaced screen's exit reaches the registry right after its death;
    // give its reader time to deliver it.
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        got.lock().unwrap().is_empty(),
        "a replaced screen's exit is not the row's screen exit"
    );
    assert_eq!(
        reg.pid_of("T12"),
        Some(second.pid),
        "the new screen stays signalable"
    );
    second.kill();
    wait("the new screen's exit reaches the hook", || {
        !got.lock().unwrap().is_empty()
    });
    assert_eq!(got.lock().unwrap()[0].screen_generation, 1);
}

#[test]
fn a_unit_rows_live_commits_name_its_unit() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let reg = TerminalRegistry::new().with_ownership(ownership.clone());
    let pid = reg
        .create_in_unit(
            &bash("sleep 30"),
            &env(),
            "T13".into(),
            "S13".into(),
            "codex",
            None,
            None,
            None,
            None,
            placement(None),
        )
        .unwrap();
    let _screen = Own::pin(pid);
    let locator = |sid: &str| SessionLocator {
        provider: "codex".into(),
        session_id: sid.into(),
    };
    let begin = |sid: &str, op: &str| match ownership.begin_start(
        "codex",
        sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        op,
        None,
        "test",
        1_000,
    ) {
        freshell_ownership::BeginOutcome::Granted { generation } => generation,
        other => panic!("the start must grant: {other:?}"),
    };
    let unit_keys = || -> Vec<String> {
        ownership
            .keys_for_unit("u1")
            .into_iter()
            .map(|(key, _)| key.session_id)
            .collect()
    };

    let g1 = begin("ses-unit-old", "op-old");
    assert_eq!(
        reg.commit_session_ref_ownership(&locator("ses-unit-old"), "op-old", g1, "T13"),
        freshell_ownership::CommitOutcome::Committed
    );
    assert_eq!(unit_keys(), vec!["ses-unit-old".to_string()]);

    let g2 = begin("ses-unit-new", "op-new");
    let (outcome, _) = reg.commit_session_ref_ownership_rekey(
        &locator("ses-unit-old"),
        &locator("ses-unit-new"),
        "op-new",
        g2,
        "T13",
    );
    assert_eq!(outcome, freshell_ownership::CommitOutcome::Committed);
    assert!(
        unit_keys().contains(&"ses-unit-new".to_string()),
        "the rebound key names the unit: {:?}",
        unit_keys()
    );
}

#[test]
fn a_new_screen_that_exits_before_it_is_installed_still_reaches_the_hook() {
    let reg = TerminalRegistry::new();
    let got = record_screen_exits(&reg);
    reg.create_in_unit(
        &bash("exit 3"),
        &env(),
        "T14".into(),
        "S14".into(),
        "codex",
        None,
        None,
        None,
        None,
        placement(None),
    )
    .unwrap();
    wait("first screen exits", || got.lock().unwrap().len() == 1);
    REPLACE_SCREEN_INTERLOCK.arm("T14");
    let replacing = reg.clone();
    let replace = std::thread::spawn(move || {
        replacing.replace_screen("T14", &bash("exit 6"), &env(), placement(None))
    });
    wait(
        "the replacement parked before installing its screen",
        || REPLACE_SCREEN_INTERLOCK.reached(),
    );
    // The new screen exits while its PTY is not yet the row's.
    wait("the new screen's exit reaches the hook", || {
        got.lock().unwrap().len() == 2
    });
    REPLACE_SCREEN_INTERLOCK.release();
    let pid = replace.join().unwrap().expect("the replacement completes");
    assert!(pid > 0);
    let exit = got.lock().unwrap()[1].clone();
    assert_eq!((exit.exit_code, exit.screen_generation), (6, 1));
    assert_eq!(
        reg.pid_of("T14"),
        None,
        "the installed screen is known exited, so its pid is never signalled"
    );
}
