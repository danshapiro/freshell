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

use std::time::Duration;

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
/// M3): the same delayed kill, arriving while the stuck restart's respawn
/// still waits for its app-server to listen, is refused as stale too and
/// cancels nothing: the replacement's start completes and it keeps running.
#[tokio::test(flavor = "multi_thread")]
async fn a_delayed_kill_from_another_device_cannot_cancel_the_replacements_start() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let first = h.create_codex(&mut ws, "crq-fs", Some("t-fence-s")).await;
    let p0 = match ownership.observe("codex", "t-fence-s") {
        freshell_ownership::OwnershipSnapshot {
            epoch,
            state: freshell_ownership::OwnershipState::Live { generation, .. },
            ..
        } => (epoch, generation),
        other => panic!("the pane holds its conversation Live: {other:?}"),
    };
    let first_unit = h.unit_for(&first).id().clone();

    let mut stuck = kill(Some(&first), "crq-fs", "rk-stuck-s");
    stuck["reason"] = json!("stuck-recovery");
    h.send(&mut ws, stuck).await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stuck-s"
        })
        .await
        .expect("the stuck restart's kill is answered");
    assert_eq!(killed["success"], true);

    // The respawn's app-server waits before it listens, so the replacement
    // stays starting while the delayed kill arrives.
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        json!({"listenDelayMs": 4000}).to_string(),
    );
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-fs", "mode": "codex", "shell": "system",
            "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": "t-fence-s"}, "restore": true}),
    )
    .await;
    let starting = {
        let state = h.state.clone();
        let ownership = ownership.clone();
        let first_unit = first_unit.clone();
        move || {
            state
                .units
                .by_create_request("crq-fs")
                .is_some_and(|entry| entry.unit.id() != &first_unit)
                && matches!(
                    ownership.observe("codex", "t-fence-s").state,
                    freshell_ownership::OwnershipState::Starting { .. }
                )
        }
    };
    fake_codex::wait_until(
        "the replacement is starting",
        Duration::from_secs(10),
        starting.clone(),
    )
    .await;
    let starting_generation = ownership.observe("codex", "t-fence-s").generation;
    assert_ne!(starting_generation, p0.1);

    let mut delayed = kill(Some(&first), "crq-fs", "rk-late-s");
    delayed["observedEpoch"] = json!(p0.0);
    delayed["observedGeneration"] = json!(p0.1);
    h.send(&mut ws, delayed).await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-late-s"
        })
        .await
        .expect("the delayed kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    assert_eq!(refused["ownerGeneration"], starting_generation, "{refused}");
    assert!(
        starting(),
        "the replacement is still starting after the refusal"
    );

    let created = h
        .next_matching(&mut ws, Duration::from_secs(20), |f| {
            f["requestId"] == "crq-fs" && (f["type"] == "terminal.created" || f["type"] == "error")
        })
        .await
        .expect("the replacement's create is answered");
    assert_eq!(created["type"], "terminal.created", "{created}");
    let replacement = created["terminalId"]
        .as_str()
        .expect("a terminal")
        .to_string();
    assert_ne!(replacement, first);
    let native = h.native_pid(&replacement);
    match ownership.observe("codex", "t-fence-s") {
        freshell_ownership::OwnershipSnapshot {
            state: freshell_ownership::OwnershipState::Live { generation, .. },
            ..
        } => assert_eq!(generation, starting_generation),
        other => panic!("the replacement holds its conversation Live: {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        fake_codex::pid_alive(native),
        "the replacement's app-server still runs"
    );
}

/// Shift-X cancels a start in ONE press (Task 13 re-review 2, R2-I2). While
/// a replacement (a stuck restart, an auto-resume, a reopen) is starting,
/// the device showing it has not yet seen its owner pair, so a kill that
/// carries a pair carries an old one and is refused as stale (another
/// device's delayed kill never cancels the replacement). The kill the
/// starting pane sends carries only its create-request id and no pair: it
/// cancels the start at once, is answered `success:true` at Gone (the
/// replacement's processes are dead by then), and no `terminal.created`
/// follows.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_press_kill_of_a_starting_replacement_carries_no_pair_and_cancels_its_start() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let ownership = h.state.ownership.clone().expect("an owner registry");
    let first = h.create_codex(&mut ws, "crq-op", Some("t-one-press")).await;
    let p0 = match ownership.observe("codex", "t-one-press") {
        freshell_ownership::OwnershipSnapshot {
            epoch,
            state: freshell_ownership::OwnershipState::Live { generation, .. },
            ..
        } => (epoch, generation),
        other => panic!("the pane holds its conversation Live: {other:?}"),
    };
    let first_unit = h.unit_for(&first).id().clone();

    let mut stuck = kill(Some(&first), "crq-op", "rk-stuck-op");
    stuck["reason"] = json!("stuck-recovery");
    h.send(&mut ws, stuck).await;
    let killed = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stuck-op"
        })
        .await
        .expect("the stuck restart's kill is answered");
    assert_eq!(killed["success"], true);
    let before_respawn: std::collections::BTreeSet<_> = std::fs::read_dir(&h.manifests)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect();

    // The respawn's app-server waits before it listens, so the replacement
    // stays starting while both kills arrive.
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        json!({"listenDelayMs": 4000}).to_string(),
    );
    h.send(
        &mut ws,
        json!({"type": "terminal.create", "requestId": "crq-op", "mode": "codex", "shell": "system",
            "cwd": h.home.path().display().to_string(),
            "sessionRef": {"provider": "codex", "sessionId": "t-one-press"}, "restore": true}),
    )
    .await;
    let starting = {
        let state = h.state.clone();
        let ownership = ownership.clone();
        let first_unit = first_unit.clone();
        move || {
            state
                .units
                .by_create_request("crq-op")
                .is_some_and(|entry| entry.unit.id() != &first_unit)
                && matches!(
                    ownership.observe("codex", "t-one-press").state,
                    freshell_ownership::OwnershipState::Starting { .. }
                )
        }
    };
    fake_codex::wait_until(
        "the replacement is starting",
        Duration::from_secs(10),
        starting.clone(),
    )
    .await;
    let allocated = h
        .state
        .units
        .by_create_request("crq-op")
        .and_then(|entry| entry.unit.label().terminal_id)
        .expect("the replacement's allocated terminal");

    // A kill carrying the pair it saw before the restart: refused as stale.
    let mut stale = kill(Some(&first), "crq-op", "rk-stale-op");
    stale["observedEpoch"] = json!(p0.0);
    stale["observedGeneration"] = json!(p0.1);
    h.send(&mut ws, stale).await;
    let refused = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            f["type"] == "terminal.killed" && f["requestId"] == "rk-stale-op"
        })
        .await
        .expect("the stale kill is answered");
    assert_eq!(refused["success"], false, "{refused}");
    assert!(
        starting(),
        "a stale kill cancels nothing: the replacement is still starting"
    );

    // The one press from the device showing the pane starting: its
    // create-request id only, no terminal and no pair.
    h.send(&mut ws, kill(None, "crq-op", "rk-one-press")).await;
    let created_before_the_answer = std::cell::Cell::new(false);
    let answered = h
        .next_matching(&mut ws, Duration::from_secs(10), |f| {
            if f["type"] == "terminal.created" && f["requestId"] == "crq-op" {
                created_before_the_answer.set(true);
            }
            f["type"] == "terminal.killed" && f["requestId"] == "rk-one-press"
        })
        .await
        .expect("the one-press kill is answered");
    assert!(
        !created_before_the_answer.get(),
        "the cancelled replacement was created"
    );
    assert_eq!(answered["success"], true, "{answered}");
    assert_eq!(
        answered["terminalId"],
        allocated.as_str(),
        "the answer names the replacement's terminal: {answered}"
    );
    for path in std::fs::read_dir(&h.manifests)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|path| !before_respawn.contains(path))
    {
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            !fake_codex::pid_alive(manifest["pid"].as_u64().unwrap() as u32),
            "the replacement's processes are dead at the answer: {manifest}"
        );
    }
    assert!(
        h.next_matching(&mut ws, Duration::from_secs(2), |f| f["type"]
            == "terminal.created"
            && f["requestId"] == "crq-op")
            .await
            .is_none(),
        "the cancelled replacement never completes its start"
    );
    assert_eq!(
        ownership.observe("codex", "t-one-press").state,
        freshell_ownership::OwnershipState::Vacant
    );
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
