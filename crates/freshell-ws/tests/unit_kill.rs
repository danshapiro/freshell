//! Shift-X (`terminal.kill`) of a Codex pane goes through its unit: the
//! kill is acknowledged only at Gone (after the app-server, everything it
//! started and its conversation lock are gone), `terminal.exit`,
//! `terminals.changed` and Vacant are published only then, a pane that is
//! still starting is reached by its create-request id and its start
//! cancelled, a second kill joins the first, an unknown terminal counts as
//! killed only when nothing holds a conversation for it, a kill that came
//! before its create refuses that create, a delayed kill from another device
//! cannot stop an auto-resumed replacement (nor cancel its start), one press
//! carrying only the create-request id cancels a starting replacement, and
//! an inventory taken during the stop reports the row stopping.
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use freshell_containment::UnitId;
use serde_json::json;
use unit_harness::{fake_codex, GoneDelay, HarnessOpts, UnitHarness};

fn kill(tid: Option<&str>, crq: &str, rid: &str) -> serde_json::Value {
    let mut f = json!({"type": "terminal.kill", "requestId": rid, "createRequestId": crq});
    if let Some(t) = tid {
        f["terminalId"] = json!(t);
    }
    f
}

async fn tui_ready(h: &UnitHarness, ws: &mut unit_harness::TestWs) {
    h.next_matching(ws, Duration::from_secs(10), |f| {
        f["type"] == "terminal.output"
            && f["data"]
                .as_str()
                .is_some_and(|d| d.contains("FAKE_TUI_READY"))
    })
    .await
    .expect("the TUI is ready");
}

/// The manifests the fake has written so far.
fn manifest_paths(h: &UnitHarness) -> BTreeSet<PathBuf> {
    std::fs::read_dir(&h.manifests)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect()
}

/// A pane whose stuck restart's respawn is still starting.
struct StartingReplacement {
    /// The pane's first terminal (the one the stuck restart killed).
    first: String,
    /// The owner pair the first terminal held Live.
    p0: (u64, u64),
    /// The replacement's unit.
    unit: UnitId,
    /// The manifests written before the respawn.
    before_respawn: BTreeSet<PathBuf>,
}

/// A Codex pane restoring `session` goes Live under `crq`, the stuck card's
/// restart kills it (process only) and is answered, and the respawn
/// re-creates the pane with the same create-request id while its app-server
/// waits 4 s before it listens. Returns once the replacement waits for its
/// app-server: a launcher the respawn started runs, the replacement's unit
/// holds the create request's entry, and the conversation is still free. A
/// restore starts its app-server before it claims the conversation and
/// claims it only once the app-server listens, so this state lasts the 4 s;
/// the claimed `Starting` state that follows lasts only until the screen is
/// placed (milliseconds), too short to aim a kill at.
async fn restart_stuck_pane(
    h: &UnitHarness,
    ws: &mut unit_harness::TestWs,
    crq: &str,
    session: &str,
) -> StartingReplacement {
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let first = h.create_codex(ws, crq, Some(session)).await;
    let p0 = match ownership.observe("codex", session) {
        freshell_ownership::OwnershipSnapshot {
            epoch,
            state: freshell_ownership::OwnershipState::Live { generation, .. },
            ..
        } => (epoch, generation),
        other => panic!("the pane holds its conversation Live: {other:?}"),
    };
    let first_unit = h.unit_for(&first).id().clone();

    let mut stuck = kill(Some(&first), crq, "rk-stuck");
    stuck["reason"] = json!("stuck-recovery");
    h.send(ws, stuck).await;
    let killed = h
        .next_matching(ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stuck"
        })
        .await
        .expect("the stuck restart's kill is answered");
    assert_eq!(killed["success"], true);
    let before_respawn = manifest_paths(h);

    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        json!({"listenDelayMs": 4000}).to_string(),
    );
    h.send(
        ws,
        json!({"type": "terminal.create", "requestId": crq, "mode": "codex", "shell": "system",
            "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": session}, "restore": true}),
    )
    .await;
    let unit = fake_codex::wait_for_state(
        "the replacement waits for its app-server to listen",
        Duration::from_secs(10),
        || {
            let launcher = manifest_paths(h).difference(&before_respawn).any(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("launcher-") && name.ends_with(".json"))
            });
            let unit = h
                .state
                .units
                .by_create_request(crq)
                .map(|entry| entry.unit.id().clone());
            let conversation = ownership.observe("codex", session).state;
            match unit {
                Some(unit)
                    if launcher
                        && unit != first_unit
                        && conversation == freshell_ownership::OwnershipState::Vacant =>
                {
                    Ok(unit)
                }
                unit => Err(format!(
                    "launcher started: {launcher}; unit: {unit:?} (first: {first_unit:?}); \
                     conversation: {conversation:?}"
                )),
            }
        },
    )
    .await;
    StartingReplacement {
        first,
        p0,
        unit,
        before_respawn,
    }
}

/// `kill` carrying the observed owner pair `pair`.
fn fenced(mut kill: serde_json::Value, pair: (u64, u64)) -> serde_json::Value {
    kill["observedEpoch"] = json!(pair.0);
    kill["observedGeneration"] = json!(pair.1);
    kill
}

/// The replacement's start runs on: its unit still holds the create
/// request's entry and no stop cancelled it.
fn still_starting(h: &UnitHarness, crq: &str, unit: &UnitId) -> bool {
    !h.state.units.start_cancelled(unit)
        && h.state
            .units
            .by_create_request(crq)
            .is_some_and(|entry| entry.unit.id() == unit)
}

/// Waits for the answer to the kill `request_id`; panics if a
/// `terminal.created` for `crq` comes first (a start the kill cancelled
/// never completes).
async fn kill_answer_before_any_create(
    h: &UnitHarness,
    ws: &mut unit_harness::TestWs,
    crq: &str,
    request_id: &str,
) -> serde_json::Value {
    let created_before_the_answer = std::cell::Cell::new(false);
    let answered = h
        .next_matching(ws, Duration::from_secs(10), |f| {
            if f["type"] == "terminal.created" && f["requestId"] == crq {
                created_before_the_answer.set(true);
            }
            f["type"] == "terminal.killed" && f["requestId"] == request_id
        })
        .await
        .unwrap_or_else(|| panic!("the kill {request_id} is answered"));
    assert!(
        !created_before_the_answer.get(),
        "the cancelled replacement was created"
    );
    answered
}

/// The start was cancelled: every process the respawn started is dead, no
/// `terminal.created` follows, and the conversation is free.
async fn assert_start_cancelled(
    h: &UnitHarness,
    ws: &mut unit_harness::TestWs,
    replacement: &StartingReplacement,
    crq: &str,
    session: &str,
) {
    for path in manifest_paths(h).difference(&replacement.before_respawn) {
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(
            !fake_codex::pid_alive(manifest["pid"].as_u64().unwrap() as u32),
            "the replacement's processes are dead at the answer: {manifest}"
        );
    }
    assert!(
        h.next_matching(ws, Duration::from_secs(2), |f| f["type"]
            == "terminal.created"
            && f["requestId"] == crq)
            .await
            .is_none(),
        "the cancelled replacement never completes its start"
    );
    assert_eq!(
        h.state
            .ownership
            .as_ref()
            .expect("an owner registry")
            .observe("codex", session)
            .state,
        freshell_ownership::OwnershipState::Vacant
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn shift_x_mid_turn_publishes_exit_and_vacant_only_after_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000, "turnSpawnsShellCommand": true, "detachedJobOnTurn": true}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-k1", Some("t-k1")).await;
    tui_ready(&h, &mut ws).await;
    h.send(
        &mut ws,
        json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"}),
    )
    .await;
    // Mid-turn: the shell command and the detached job are running.
    let manifests = h.manifests.clone();
    let native = h.native_pid(&tid);
    fake_codex::wait_until(
        "the turn's shell command and detached job run",
        Duration::from_secs(10),
        move || {
            std::fs::read_to_string(manifests.join(format!("native-{native}.json")))
                .ok()
                .and_then(|raw| serde_json::from_str::<fake_codex::NativeManifest>(&raw).ok())
                .is_some_and(|m| !m.children.shell.is_empty() && !m.children.detached.is_empty())
        },
    )
    .await;
    let manifest = h.native_manifest(&tid);
    let lock = h.lock("t-k1");
    assert!(fake_codex::lock_held(&lock));
    h.send(&mut ws, kill(Some(&tid), "crq-k1", "rk1")).await;
    let mut seen = std::collections::BTreeSet::new();
    while seen.len() < 4 {
        let f = h
            .next_matching(&mut ws, Duration::from_secs(10), |f| {
                (f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str())
                    || f["type"] == "terminals.changed"
                    || (f["type"] == "session.runtimeOwner"
                        && f["sessionId"] == "t-k1"
                        && f["ownerKind"] == "vacant")
                    || (f["type"] == "terminal.killed" && f["requestId"] == "rk1")
            })
            .await
            .unwrap_or_else(|| panic!("all four publications arrive (seen {seen:?})"));
        assert!(
            !fake_codex::pid_alive(native),
            "{} published while the app-server lived",
            f["type"]
        );
        assert!(
            !fake_codex::lock_held(&lock),
            "{} published while the lock was held",
            f["type"]
        );
        if f["type"] == "terminal.killed" {
            assert_eq!(f["success"], true);
        }
        seen.insert(f["type"].as_str().unwrap().to_string());
    }
    let after: fake_codex::NativeManifest = serde_json::from_str(
        &std::fs::read_to_string(h.manifests.join(format!("native-{native}.json")))
            .expect("the native's manifest"),
    )
    .expect("native manifest JSON");
    assert_eq!(
        after
            .signals
            .iter()
            .map(|s| s.sig.as_str())
            .collect::<Vec<_>>(),
        vec!["SIGINT"]
    );
    for pid in manifest
        .children
        .shell
        .iter()
        .chain(manifest.children.detached.iter())
    {
        assert!(!fake_codex::pid_alive(*pid), "descendant {pid} survived");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_during_start_cancels_the_start() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"listenDelayMs": 4000}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-start", "mode": "codex", "shell": "system",
            "sessionRef": {"provider": "codex", "sessionId": "t-start"}, "restore": true}),
    )
    .await;
    // The launcher and the native are spawned, not yet listening.
    let manifests = h.manifests.clone();
    fake_codex::wait_until(
        "the start is under way",
        Duration::from_secs(10),
        move || {
            std::fs::read_dir(&manifests)
                .map(|entries| entries.flatten().count() >= 2)
                .unwrap_or(false)
        },
    )
    .await;
    let allocated = h
        .state
        .units
        .by_create_request("crq-start")
        .and_then(|entry| entry.unit.label().terminal_id)
        .expect("the start's allocated terminal");
    h.send(&mut ws, kill(None, "crq-start", "rks")).await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rks"
        })
        .await
        .expect("ack");
    assert_eq!(killed["success"], true);
    assert_eq!(
        killed["terminalId"],
        allocated.as_str(),
        "the answer names the terminal the start was allocated: {killed}"
    );
    for e in std::fs::read_dir(&h.manifests).unwrap().flatten() {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
        assert!(
            !fake_codex::pid_alive(v["pid"].as_u64().unwrap() as u32),
            "start leftovers die: {v}"
        );
    }
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(2), |f| f["type"]
            == "terminal.created"
            && f["requestId"] == "crq-start")
            .await
            .is_none(),
        "the cancelled start never completes"
    );
    let snap = h
        .state
        .ownership
        .as_ref()
        .unwrap()
        .observe("codex", "t-start");
    assert_eq!(snap.state, freshell_ownership::OwnershipState::Vacant);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_kill_joins_the_first_and_both_ack_at_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000}),
        ..Default::default()
    })
    .await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-dbl", Some("t-dbl")).await;
    let native = h.native_pid(&tid);
    h.send(&mut ws, kill(Some(&tid), "crq-dbl", "rd1")).await;
    h.send(&mut ws, kill(Some(&tid), "crq-dbl", "rd2")).await;
    // Both are answered at the one Gone, in either order.
    let mut answered = std::collections::BTreeSet::new();
    while answered.len() < 2 {
        let f = h
            .next_matching(&mut ws, Duration::from_secs(10), |f| {
                f["type"] == "terminal.killed"
                    && (f["requestId"] == "rd1" || f["requestId"] == "rd2")
            })
            .await
            .unwrap_or_else(|| panic!("both kills are answered (answered {answered:?})"));
        assert_eq!(f["success"], true);
        assert!(!fake_codex::pid_alive(native));
        answered.insert(f["requestId"].as_str().unwrap().to_string());
    }
    let after: fake_codex::NativeManifest = serde_json::from_str(
        &std::fs::read_to_string(h.manifests.join(format!("native-{native}.json")))
            .expect("the native's manifest"),
    )
    .expect("native manifest JSON");
    assert!(after.signals.len() <= 1, "one stop sequence, not two");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_terminal_is_success_only_because_nothing_holds_anything() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    h.send(&mut ws, kill(Some("no-such-terminal"), "crq-none", "rn"))
        .await;
    let f = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rn"
        })
        .await
        .unwrap();
    assert_eq!(f["success"], true);
}

/// Stage 2: LB-16. A kill that arrives before its pane's create (it names
/// the pane by createRequestId alone) is remembered: the late create is
/// refused as stopped and spawns nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_before_its_create_arrives_refuses_the_create_as_stopped() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    h.send(&mut ws, kill(None, "crq-held", "rh")).await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rh"
        })
        .await
        .expect("the kill is answered");
    assert_eq!(killed["success"], true);
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-held", "mode": "codex", "shell": "system",
            "sessionRef": {"provider": "codex", "sessionId": "t-held"}, "restore": true}),
    )
    .await;
    let answer = h
        .next_matching(&mut ws, Duration::from_secs(5), |f| {
            f["requestId"] == "crq-held"
                && (f["type"] == "error" || f["type"] == "terminal.created")
        })
        .await
        .expect("the create is answered");
    assert_eq!(answer["type"], "error", "{answer}");
    assert_eq!(answer["code"], "INVALID_TERMINAL_ID");
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(2), |f| f["type"]
            == "terminal.created"
            && f["requestId"] == "crq-held")
            .await
            .is_none(),
        "the killed pane is never created"
    );
    assert_eq!(
        std::fs::read_dir(&h.manifests).unwrap().flatten().count(),
        0,
        "nothing was spawned"
    );
}

/// Stage 2: LB-34. A kill from another device that names the pane as it was
/// before its stuck restart (the old terminal and its observed owner pair)
/// is refused as stale and stops nothing: the auto-resumed replacement,
/// found by the same createRequestId, keeps running.
#[tokio::test(flavor = "multi_thread")]
async fn a_delayed_kill_from_another_device_cannot_stop_the_auto_resumed_replacement() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let first = h.create_codex(&mut ws, "crq-f", Some("t-fence")).await;
    let live_pair = |label: &str| match ownership.observe("codex", "t-fence") {
        freshell_ownership::OwnershipSnapshot {
            epoch,
            state: freshell_ownership::OwnershipState::Live { generation, .. },
            ..
        } => (epoch, generation),
        other => panic!("{label}: the pane holds its conversation Live: {other:?}"),
    };
    let p0 = live_pair("first");

    // The stuck card's restart: a process-only kill, then the respawn
    // re-creates the pane with the same createRequestId.
    let mut stuck = kill(Some(&first), "crq-f", "rk-stuck");
    stuck["reason"] = json!("stuck-recovery");
    h.send(&mut ws, stuck).await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stuck"
        })
        .await
        .expect("the stuck restart's kill is answered");
    assert_eq!(killed["success"], true);
    let replacement = h.create_codex(&mut ws, "crq-f", Some("t-fence")).await;
    assert_ne!(replacement, first);
    let p1 = live_pair("replacement");
    let native = h.native_pid(&replacement);

    let mut delayed = kill(Some(&first), "crq-f", "rk-late");
    delayed["observedEpoch"] = json!(p0.0);
    delayed["observedGeneration"] = json!(p0.1);
    h.send(&mut ws, delayed).await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-late"
        })
        .await
        .expect("the delayed kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    assert_eq!(refused["ownerGeneration"], p1.1, "{refused}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(
        fake_codex::pid_alive(native),
        "the replacement's app-server still runs"
    );
    assert_eq!(live_pair("after the delayed kill"), p1);
}

/// Stage 2: LB-34 while the replacement is still starting (Task 13 review
/// M3; re-review 3, R3-M1): the same delayed kill, arriving while the stuck
/// restart's respawn still waits for its app-server to listen, is refused as
/// stale too and cancels nothing: the replacement's start completes and it
/// keeps running. The respawn has not claimed the conversation yet, so the
/// refusal teaches the free conversation's current pair.
#[tokio::test(flavor = "multi_thread")]
async fn a_delayed_kill_from_another_device_cannot_cancel_the_replacements_start() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let replacement = restart_stuck_pane(&h, &mut ws, "crq-fs", "t-fence-s").await;
    let free = ownership.observe("codex", "t-fence-s");
    assert_ne!(
        (free.epoch, free.generation),
        replacement.p0,
        "the pair from before the restart is no longer current"
    );

    let delayed = fenced(
        kill(Some(&replacement.first), "crq-fs", "rk-late-s"),
        replacement.p0,
    );
    h.send(&mut ws, delayed).await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-late-s"
        })
        .await
        .expect("the delayed kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    assert_eq!(refused["ownerEpoch"], free.epoch, "{refused}");
    assert_eq!(refused["ownerGeneration"], free.generation, "{refused}");
    assert!(
        still_starting(&h, "crq-fs", &replacement.unit),
        "the refused kill cancelled nothing: the replacement is still starting"
    );

    let created = h
        .next_matching(&mut ws, Duration::from_secs(20), |f| {
            f["requestId"] == "crq-fs" && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the replacement's create is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    let terminal = created["terminalId"]
        .as_str()
        .expect("a terminal")
        .to_string();
    assert_ne!(terminal, replacement.first);
    assert_eq!(
        h.unit_for(&terminal).id(),
        &replacement.unit,
        "the start the kill reached is the one that completed"
    );
    let native = h.native_pid(&terminal);
    match ownership.observe("codex", "t-fence-s") {
        freshell_ownership::OwnershipSnapshot {
            state: freshell_ownership::OwnershipState::Live { owner, .. },
            ..
        } => assert_eq!(owner.terminal_id.as_deref(), Some(terminal.as_str())),
        other => panic!("the replacement holds its conversation Live: {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        fake_codex::pid_alive(native),
        "the replacement's app-server still runs"
    );
}

/// The stale-kill refusal is "refresh and retry" while a replacement is
/// still starting too (Task 13 re-review 3, R3-M1): a kill carrying the
/// pair the refusal taught (the free conversation's current pair) names
/// the conversation as it is now, so it cancels the start, is answered
/// `success:true` at Gone (the replacement's processes are dead by then),
/// and no `terminal.created` follows.
#[tokio::test(flavor = "multi_thread")]
async fn a_kill_carrying_the_pair_its_refusal_taught_cancels_a_starting_replacement() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let replacement = restart_stuck_pane(&h, &mut ws, "crq-rt", "t-retry").await;

    h.send(
        &mut ws,
        fenced(
            kill(Some(&replacement.first), "crq-rt", "rk-stale-rt"),
            replacement.p0,
        ),
    )
    .await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stale-rt"
        })
        .await
        .expect("the stale kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    let taught = (
        refused["ownerEpoch"].as_u64().expect("the current epoch"),
        refused["ownerGeneration"]
            .as_u64()
            .expect("the current generation"),
    );
    assert!(
        still_starting(&h, "crq-rt", &replacement.unit),
        "a stale kill cancels nothing: the replacement is still starting"
    );

    h.send(
        &mut ws,
        fenced(kill(Some(&replacement.first), "crq-rt", "rk-retry"), taught),
    )
    .await;
    let answered = kill_answer_before_any_create(&h, &mut ws, "crq-rt", "rk-retry").await;
    assert_eq!(answered["success"], true, "{answered}");
    assert_start_cancelled(&h, &mut ws, &replacement, "crq-rt", "t-retry").await;
}

/// Shift-X cancels a start in ONE press (Task 13 re-review 2, R2-I2). While
/// a replacement (a stuck restart, an auto-resume, a reopen) is starting,
/// the device showing it has not yet seen its owner pair, so a kill that
/// carries a pair carries an old one and is refused as stale (another
/// device's delayed kill never cancels the replacement). The kill the
/// starting pane sends carries only its create-request id and no pair: it
/// cancels the start at once, is answered `success:true` at Gone (the
/// replacement's processes are dead by then), and no `terminal.created`
/// follows. Both kills land while the replacement's app-server waits to
/// listen, before the replacement claims the conversation.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_press_kill_of_a_starting_replacement_carries_no_pair_and_cancels_its_start() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let replacement = restart_stuck_pane(&h, &mut ws, "crq-op", "t-one-press").await;
    let allocated = h
        .state
        .units
        .get(&replacement.unit)
        .and_then(|entry| entry.unit.label().terminal_id)
        .expect("the replacement's allocated terminal");

    // A kill carrying the pair it saw before the restart: refused as stale.
    h.send(
        &mut ws,
        fenced(
            kill(Some(&replacement.first), "crq-op", "rk-stale-op"),
            replacement.p0,
        ),
    )
    .await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stale-op"
        })
        .await
        .expect("the stale kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    assert!(
        still_starting(&h, "crq-op", &replacement.unit),
        "a stale kill cancels nothing: the replacement is still starting"
    );

    // The one press from the device showing the pane starting: its
    // create-request id only, no terminal and no pair.
    h.send(&mut ws, kill(None, "crq-op", "rk-one-press")).await;
    let answered = kill_answer_before_any_create(&h, &mut ws, "crq-op", "rk-one-press").await;
    assert_eq!(answered["success"], true, "{answered}");
    assert_eq!(
        answered["terminalId"],
        allocated.as_str(),
        "the answer names the replacement's terminal: {answered}"
    );
    assert_start_cancelled(&h, &mut ws, &replacement, "crq-op", "t-one-press").await;
}

/// Stage 2: LB-34. "Stopping…" is derived from server state: an inventory
/// taken while a pane's stop is in flight reports the row `stopping` (with
/// when the stop began), and one taken after Gone no longer lists it.
#[tokio::test(flavor = "multi_thread")]
async fn an_inventory_taken_during_a_stop_reports_stopping() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-inv", Some("t-inv")).await;
    let _delay = GoneDelay::set(3000);
    let sent_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    h.send(&mut ws, kill(Some(&tid), "crq-inv", "rk-inv")).await;
    // The stop has begun once the conversation's live frame says so.
    h.next_matching(&mut ws, Duration::from_secs(5), |f| {
        f["type"] == "session.runtimeOwner"
            && f["sessionId"] == "t-inv"
            && f["transition"] == "stopping"
    })
    .await
    .expect("the stop began");
    let (_second, inventory) = h.connect_with_inventory().await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals")
        .iter()
        .find(|row| row["terminalId"] == tid.as_str())
        .unwrap_or_else(|| panic!("the stopping row is listed: {inventory}"))
        .clone();
    assert_eq!(row["runtimeStatus"], "stopping", "{row}");
    let since = row["stoppingSince"]
        .as_i64()
        .expect("a numeric stoppingSince");
    assert!(
        since >= sent_at,
        "{since} is no earlier than the kill ({sent_at})"
    );

    h.next_matching(&mut ws, Duration::from_secs(15), |f| {
        f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()
    })
    .await
    .expect("terminal.exit at Gone");
    let (_third, inventory) = h.connect_with_inventory().await;
    assert!(
        !inventory["terminals"]
            .as_array()
            .expect("terminals")
            .iter()
            .any(|row| row["terminalId"] == tid.as_str()),
        "a Gone pane is no longer listed: {inventory}"
    );
}
