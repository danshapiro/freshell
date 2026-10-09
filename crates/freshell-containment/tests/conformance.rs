#![cfg(target_os = "linux")]
//! The one stop sequence, on every backend this host can run. Every process
//! signalled here was spawned by the test (through the unit under test).
//! Runtimes get two workers each: the Docker sandbox caps the container at
//! 512 tasks (threads and processes), and a default multi-thread runtime
//! starts one worker per CPU.
mod support;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;

fn label() -> UnitLabel {
    UnitLabel {
        provider: "test".into(),
        ..Default::default()
    }
}

fn tag_only() -> Containment {
    Containment::tag_backend(SelectOptions {
        shim: Some(test_shim()),
        ..Default::default()
    })
}

/// A plain `sleep 600` child of the test: no placement, no tag.
fn plain_sleep() -> std::process::Child {
    std::process::Command::new("sleep")
        .arg("600")
        .spawn()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn force_stop_interrupts_main_first_then_kills_the_whole_unit() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default()); // ignores SIGINT
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let t0 = Instant::now();
        let report = unit
            .stop(StopRequest::new(
                StopMode::Force,
                StopReason::ShiftX,
                "test",
            ))
            .wait()
            .await;
        let took = t0.elapsed();
        assert!(
            std::fs::read_to_string(&s.marker).unwrap().contains("INT"),
            "{name}: SIGINT first"
        );
        assert!(
            took >= Duration::from_millis(900) && took < Duration::from_secs(4),
            "{name}: {took:?}"
        );
        assert_eq!(report.reason, "shift-x");
        assert_eq!(report.mode, "force");
        assert!(report.lock_released);
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(survivors.is_empty(), "{name}: survivors {survivors:?}");
        for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
            assert!(!alive(pid), "{name}: pid {pid} survived Shift-X");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn force_stop_kills_the_rest_as_soon_as_main_exits() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts {
            exit_on_int: true,
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let t0 = Instant::now();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        assert!(
            t0.elapsed() < Duration::from_millis(800),
            "{name}: no idle wait after main exit"
        );
        unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(!alive(p.nohup) && !alive(p.setsid), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn graceful_stop_escalates_after_its_grace() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default()); // ignores SIGTERM
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let report = unit
            .stop(StopRequest::new(
                StopMode::Graceful {
                    grace: Duration::from_millis(400),
                },
                StopReason::Cleanup,
                "test",
            ))
            .wait()
            .await;
        assert!(
            std::fs::read_to_string(&s.marker).unwrap().contains("TERM"),
            "{name}: polite first"
        );
        assert!(report.escalated, "{name}: escalated after grace");
        assert!(!alive(p.main), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_force_stop_joins_and_skips_the_grace() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let t0 = Instant::now();
        let first = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "a"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let second = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "b"));
        let (r1, r2) = (first.wait().await, second.wait().await);
        assert_eq!(r1, r2, "{name}: one stop, joined");
        assert!(r1.escalated, "{name}");
        assert!(
            t0.elapsed() < Duration::from_millis(800),
            "{name}: {:?}",
            t0.elapsed()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn force_on_a_graceful_stop_escalates_immediately() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let t0 = Instant::now();
        let polite = unit.stop(StopRequest::new(
            StopMode::Graceful {
                grace: Duration::from_secs(30),
            },
            StopReason::Cleanup,
            "cleanup",
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "user",
        ));
        assert!(polite.wait().await.escalated);
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "{name}: {:?}",
            t0.elapsed()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_codex_managed_daemon_is_never_signalled() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts {
            managed_daemon_child: true,
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        assert!(alive(p.daemon));
        let daemon = ProcWatch::open(p.daemon).unwrap();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(
            alive(p.daemon) && !daemon.has_exited(),
            "{name}: managed daemon must survive"
        );
        assert!(
            survivors.iter().all(|s| s.pid != p.daemon),
            "{name}: a spared daemon is not a survivor"
        );
        assert!(!alive(p.main) && !alive(p.nohup), "{name}");
        daemon.signal(Sig::Kill).unwrap(); // our own test process, pinned
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_member_holding_the_conversation_lock_is_killed_before_gone() {
    for (name, c) in backends() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("t.lock");
        std::fs::write(&lock, b"").unwrap();
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        unit.set_lock_paths(vec![lock.clone()]);
        let s = agent_script(&AgentOpts {
            exit_on_int: true,
            lock_child: Some(lock.clone()),
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while lock_holders(std::slice::from_ref(&lock)).is_empty() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let report = unit
            .stop(StopRequest::new(
                StopMode::Force,
                StopReason::ShiftX,
                "test",
            ))
            .wait()
            .await;
        assert!(report.lock_released, "{name}");
        assert!(
            lock_holders(std::slice::from_ref(&lock)).is_empty(),
            "{name}: lock released at Gone"
        );
        assert!(!alive(p.locker), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn placement_carries_the_unit_tag_and_a_unit_with_nothing_running_is_gone_at_once() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let placement = unit.placement(MemberRole::Screen).unwrap();
        assert!(
            placement
                .env
                .contains(&(UNIT_ENV.to_string(), unit.id().as_str().to_string())),
            "{name}"
        );
        let t0 = Instant::now();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::StartCancelled,
            "test",
        ))
        .wait()
        .await;
        assert!(t0.elapsed() < Duration::from_millis(500), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_is_persisted_before_any_signal_and_on_gone_runs_before_the_handle_resolves() {
    let root = tempfile::tempdir().unwrap();
    for (name, c) in backends_with_state(root.path()) {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let path = record_path(root.path(), name, &unit);
        let at_create: UnitRecord = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(at_create.state, UnitRecordState::Running, "{name}");
        let s = agent_script(&AgentOpts {
            exit_on_int: true,
            on_int_copy: Some(path.clone()),
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let record_existed = Arc::new(AtomicBool::new(false));
        let (seen2, existed2, path2) = (seen.clone(), record_existed.clone(), path.clone());
        let handle = unit.stop(
            StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")
                .operation("op-1")
                .on_gone(Box::new(move |report: StopReport| {
                    Box::pin(async move {
                        seen2
                            .lock()
                            .unwrap()
                            .push(format!("gone:{}", report.reason));
                        existed2.store(path2.exists(), Ordering::SeqCst);
                    })
                })),
        );
        handle.wait().await;
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["gone:shift-x".to_string()],
            "{name}: on_gone ran before wait() returned"
        );
        assert!(
            record_existed.load(Ordering::SeqCst),
            "{name}: the record still existed while on_gone ran"
        );
        assert!(!path.exists(), "{name}: the record is deleted at Gone");
        let at_signal: UnitRecord = serde_json::from_slice(
            &std::fs::read(s.at_signal()).expect("the INT trap copied the record"),
        )
        .unwrap();
        match at_signal.state {
            UnitRecordState::Stopping {
                reason,
                operation_id,
                ..
            } => {
                assert_eq!(reason, "shift-x", "{name}");
                assert_eq!(operation_id.as_deref(), Some("op-1"), "{name}");
            }
            other => panic!("{name}: Stopping was not saved before SIGINT: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_codex_daemon_family_is_never_signalled() {
    let (cap, _guard) = capture::install();
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts {
            daemon_family: true,
            managed_daemon_child: true,
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let family: Vec<(u32, u64)> = [p.daemon, p.updater, p.installer, p.legacy]
            .into_iter()
            .map(|pid| {
                assert!(alive(pid), "{name}: stand-in {pid} started");
                (pid, process::start_time(pid).unwrap())
            })
            .collect();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        for (pid, start) in &family {
            assert!(
                alive(*pid),
                "{name}: daemon-family stand-in {pid} was killed"
            );
            assert_eq!(process::start_time(*pid).unwrap(), *start, "{name}");
            assert!(
                survivors.iter().all(|s| s.pid != *pid),
                "{name}: a spared process is not a survivor"
            );
        }
        for pid in [p.main, p.setsid, p.nohup] {
            assert!(!alive(pid), "{name}: {pid} survived");
        }
        assert!(cap.has(tracing::Level::INFO, "unit.stop.spared"), "{name}");
        for (pid, start) in family {
            if let Ok(watch) = ProcWatch::open_expecting(pid, start) {
                watch.signal(Sig::Kill).unwrap();
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pinned_root_is_stopped_even_when_the_backend_finds_no_members() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let mut sleep = tokio::process::Command::new("sleep")
            .arg("600")
            .spawn()
            .unwrap();
        let watch = ProcWatch::open(sleep.id().unwrap()).unwrap();
        unit.add_root(watch.clone());
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        assert!(
            watch.has_exited(),
            "{name}: the pinned root was not stopped"
        );
        let _ = sleep.wait().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_unit_refuses_members_once_its_stop_has_begun() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let handle = unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ));
        assert!(unit.placement(MemberRole::Screen).is_err(), "{name}");
        assert!(
            unit.tokio_command("true", &[], MemberRole::Agent).is_err(),
            "{name}"
        );
        let mut late = plain_sleep();
        let watch = ProcWatch::open(late.id()).unwrap();
        unit.set_screen(watch.clone());
        tokio::time::timeout(Duration::from_secs(5), watch.exited())
            .await
            .unwrap_or_else(|_| panic!("{name}: a member pinned after the stop began survived"))
            .unwrap();
        let _ = late.wait();
        handle.wait().await;
        assert!(unit.placement(MemberRole::Screen).is_err(), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn confirm_placement_accepts_members_and_rejects_strangers() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let main = unit.main().unwrap().pid();
        unit.confirm_placement(main).unwrap();
        unit.confirm_placement(p.main).unwrap();
        let mut stranger = plain_sleep();
        let refused = unit.confirm_placement(stranger.id()).unwrap_err();
        assert_ne!(refused.kind(), std::io::ErrorKind::NotFound, "{name}");
        stranger.kill().unwrap();
        stranger.wait().unwrap();
        assert_eq!(
            unit.confirm_placement(stranger.id()).unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
            "{name}"
        );
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_untagged_child_reparented_during_the_grace_is_still_killed() {
    let c = tag_only();
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let s = agent_script(&AgentOpts {
        untagged_child: true,
        exit_on_int: true,
        ..Default::default()
    });
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    assert!(alive(p.untagged));
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ))
    .wait()
    .await;
    unit.stop_in_flight().unwrap().wait_swept().await;
    assert!(!alive(p.untagged), "the untagged child survived");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_detached_job_that_clears_its_environment_after_its_parent_exits_is_killed() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts {
            envless_job: true,
            ..Default::default()
        });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        eventually(
            Duration::from_secs(10),
            "the detached job cleared its environment and lost its parent",
            || {
                environ_is_empty(p.envless)
                    && process::parent(p.envless).is_some_and(|pp| pp != p.envless_intermediate)
            },
        )
        .await;
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(!alive(p.envless), "{name}: the detached job survived");
        assert!(
            survivors.iter().all(|s| s.pid != p.envless),
            "{name}: {survivors:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_user_kill_joining_a_weaker_stop_wins_its_reason() {
    for (name, c) in backends() {
        // (a) A user Shift-X joining a polite cleanup stop.
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default()); // ignores SIGTERM and SIGINT
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let t0 = Instant::now();
        let cleanup = unit.stop(StopRequest::new(
            StopMode::Graceful {
                grace: Duration::from_secs(30),
            },
            StopReason::Cleanup,
            "cleanup",
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "user",
        ));
        let report = cleanup.wait().await;
        assert_eq!(report.reason, "shift-x", "{name}");
        assert_eq!(report.mode, "force", "{name}");
        assert!(report.escalated, "{name}");
        assert!(t0.elapsed() < Duration::from_secs(2), "{name}");

        // (b) A kill command joining a respawn's stop.
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let respawn = unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::Respawn,
            "respawn",
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::KillCommand,
            "mcp",
        ));
        assert_eq!(respawn.wait().await.reason, "kill-command", "{name}");

        // (c) A weaker joiner never replaces the reason.
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let user = unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "user",
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::Respawn,
            "respawn",
        ));
        assert_eq!(user.wait().await.reason, "shift-x", "{name}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_stop_that_panics_is_rerun_once_in_force_and_never_poisons_waiters() {
    let (cap, _guard) = capture::install();
    let c = tag_only();
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let mut sleep = plain_sleep();
    let watch = ProcWatch::open(sleep.id()).unwrap();
    unit.set_screen(watch.clone());
    let gone_calls = Arc::new(AtomicUsize::new(0));
    let calls = gone_calls.clone();
    let handle = unit.stop(
        StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")
            .soft_interrupt(Box::new(|| panic!("soft interrupt failed")))
            .on_gone(Box::new(move |_| {
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                })
            })),
    );
    let other = handle.clone();
    let (a, b) = tokio::join!(handle.wait(), other.wait());
    assert_eq!(a, b, "every waiter gets the same report");
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.panicked"));
    assert_eq!(
        gone_calls.load(Ordering::SeqCst),
        1,
        "on_gone ran exactly once"
    );
    assert!(watch.has_exited(), "the screen was stopped");
    let _ = sleep.wait();
}
