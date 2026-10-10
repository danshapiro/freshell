#![cfg(target_os = "linux")]
//! Per-unit records: the only persisted unit state and the only way a server
//! finds units after a restart. Every process spawned, signalled or checked
//! here was started by the test.
//! Runtimes get two workers each: the Docker sandbox caps the container at
//! 512 tasks (threads and processes), and a default multi-thread runtime
//! starts one worker per CPU.
mod support;

use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;

fn label() -> UnitLabel {
    UnitLabel {
        provider: "test".into(),
        ..Default::default()
    }
}

fn read_record(path: &std::path::Path) -> UnitRecord {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_unit_records_the_unit_before_anything_spawns_and_gone_deletes_it() {
    let root = StateRoot::new();
    for (name, c) in backends_with_state(root.path()) {
        let unit = c
            .create_unit(
                UnitId::mint(),
                UnitLabel {
                    provider: "test".into(),
                    mode: "shell".into(),
                    terminal_id: Some("t1".into()),
                    create_request_id: Some("c1".into()),
                    session_id: Some("s1".into()),
                },
            )
            .unwrap();
        let records = c.recorded_units().unwrap();
        assert_eq!(records.len(), 1, "{name}: {records:?}");
        let record = &records[0];
        assert_eq!(&record.unit_id, unit.id(), "{name}");
        assert_eq!(record.provider, "test");
        assert_eq!(record.mode, "shell");
        assert_eq!(record.terminal_id.as_deref(), Some("t1"));
        assert_eq!(record.create_request_id.as_deref(), Some("c1"));
        assert_eq!(
            record.conversation_keys,
            vec![("test".to_string(), "s1".to_string())]
        );
        assert!(record.roots.is_empty(), "{name}: nothing has spawned yet");
        assert_eq!(record.state, UnitRecordState::Running);
        let path = record_path(root.path(), name, &unit);
        assert_eq!(
            &read_record(&path),
            record,
            "{name}: the file says the same"
        );

        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        let main = unit.main().unwrap().identity().clone();
        assert!(
            read_record(&path).roots.contains(&(main.pid, main.start)),
            "{name}: the main is recorded as a root"
        );
        unit.note_conversation("test", "s2");
        assert!(read_record(&path)
            .conversation_keys
            .contains(&("test".to_string(), "s2".to_string())));
        assert_eq!(
            c.recorded_units().unwrap()[0],
            read_record(&path),
            "{name}: the store keeps the latest record"
        );

        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait()
        .await;
        assert!(!path.exists(), "{name}: Gone deletes the record");
        assert!(c.recorded_units().unwrap().is_empty(), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_finishes_only_its_own_recorded_units() {
    let root_a = StateRoot::new();
    let root_b = StateRoot::new();
    for ((name, a), (_, b)) in backends_with_state(root_a.path())
        .into_iter()
        .zip(backends_with_state(root_b.path()))
    {
        let unit_a = a.create_unit(UnitId::mint(), label()).unwrap();
        let s_a = agent_script(&AgentOpts::default());
        let _child_a = spawn_main(&unit_a, &s_a).await;
        let p_a = read_pids(&s_a).await;
        let a_starts: Vec<(u32, u64)> = [p_a.main, p_a.setsid, p_a.nohup]
            .into_iter()
            .map(|pid| (pid, process::start_time(pid).unwrap()))
            .collect();

        let unit_b = b.create_unit(UnitId::mint(), label()).unwrap();
        let s_b = agent_script(&AgentOpts::default());
        let _child_b = spawn_main(&unit_b, &s_b).await;
        let p_b = read_pids(&s_b).await;
        let b_shim = unit_b.main().unwrap().pid();

        // B "restarts": its unit and containment go away without a stop.
        drop(unit_b);
        drop(b);
        let b = rebuild(name, root_b.path());
        let records = b.recorded_units().unwrap();
        assert_eq!(records.len(), 1, "{name}: B finds exactly its own record");
        for record in &records {
            let unit = b.reopen_unit(record, label()).unwrap();
            unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::BootFinish,
                "boot",
            ))
            .wait()
            .await;
            unit.stop_in_flight().unwrap().wait_swept().await;
        }
        for pid in [b_shim, p_b.main, p_b.setsid, p_b.pgrp, p_b.nohup] {
            assert!(
                !alive(pid),
                "{name}: B's member {pid} survived its boot finish"
            );
        }
        assert!(b.recorded_units().unwrap().is_empty(), "{name}");
        for (pid, start) in &a_starts {
            assert!(alive(*pid), "{name}: A's member {pid} was touched");
            assert_eq!(process::start_time(*pid).unwrap(), *start, "{name}");
        }
        unit_a
            .stop(StopRequest::new(
                StopMode::Force,
                StopReason::ShiftX,
                "test",
            ))
            .wait()
            .await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_containment_on_the_same_state_root_does_not_take_over_its_records() {
    let root = StateRoot::new();
    for (name, a) in backends_with_state(root.path()) {
        let unit_a = a.create_unit(UnitId::mint(), label()).unwrap();
        let path_a = record_path(root.path(), name, &unit_a);
        let before = std::fs::read(&path_a).unwrap();

        let b = rebuild(name, root.path());
        assert!(
            b.recorded_units().unwrap().is_empty(),
            "{name}: A's record is held by its live owner"
        );
        let unit_b = b.create_unit(UnitId::mint(), label()).unwrap();
        let path_b = record_path(root.path(), name, &unit_b);
        assert_eq!(&read_record(&path_b).unit_id, unit_b.id(), "{name}");
        assert_eq!(
            std::fs::read(&path_a).unwrap(),
            before,
            "{name}: A's record unchanged"
        );

        // A crashes: its unit and containment go away without a stop.
        let a_record = read_record(&path_a);
        drop(unit_a);
        drop(a);
        let c = rebuild(name, root.path());
        assert_eq!(
            c.recorded_units().unwrap(),
            vec![a_record],
            "{name}: only the record no live server holds"
        );
        drop(unit_b);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_stopping_write_sends_no_signal_until_a_force_join_saves_it() {
    let (cap, _guard) = capture::install();
    let root = tempfile::tempdir().unwrap();
    let c = rebuild("tag", root.path());
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    // Ignores SIGINT: only the joining Shift-X can end the soft grace early.
    let s = agent_script(&AgentOpts::default());
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;

    let units = root.path().join("tag").join("units");
    let aside = root.path().join("tag").join("units-aside");
    std::fs::rename(&units, &aside).unwrap();
    std::fs::write(&units, b"not a directory").unwrap();

    let t0 = Instant::now();
    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    assert!(handle.wait_for(Duration::from_secs(2)).await.is_none());
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.persist_failed"));
    assert!(alive(p.main), "no signal before Stopping is saved");
    assert!(!s.marker.exists(), "no SIGINT before Stopping is saved");
    assert!(
        !cap.has(tracing::Level::INFO, "unit.stop.signal_sent"),
        "nothing is signalled before Stopping is saved"
    );
    assert!(handle
        .wait_for(Duration::from_millis(5500).saturating_sub(t0.elapsed()))
        .await
        .is_none());
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"));

    std::fs::remove_file(&units).unwrap();
    std::fs::rename(&aside, &units).unwrap();
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    let report = handle.wait().await;
    assert!(
        cap.has_with(
            tracing::Level::INFO,
            "unit.stop.signal_sent",
            &[("signal", "SIGINT"), ("target", "main")]
        ),
        "the saved stop sends the soft signal first"
    );
    assert!(
        report.escalated,
        "a Shift-X on a Stopping unit escalates straight to force, even the one that saved Stopping"
    );
    assert!(!units.join(format!("{}.json", unit.id())).exists());
}

#[tokio::test(flavor = "current_thread")]
async fn boot_never_signals_a_recorded_root_whose_start_time_differs() {
    let (cap, _guard) = capture::install();
    let root = StateRoot::new();
    for (name, c) in backends_with_state(root.path()) {
        let mut sleep = OwnChild::sleep();
        let pid = sleep.id();
        let start = process::start_time(pid).unwrap();
        let record = |roots: Vec<(u32, u64)>| UnitRecord {
            unit_id: UnitId::mint(),
            provider: "test".into(),
            mode: "codex".into(),
            terminal_id: None,
            create_request_id: None,
            conversation_keys: Vec::new(),
            roots,
            state: UnitRecordState::Running,
            legacy_tag: None,
        };

        let unit = c
            .reopen_unit(&record(vec![(pid, start + 1)]), label())
            .unwrap();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::BootFinish,
            "boot",
        ))
        .wait()
        .await;
        unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(
            alive(pid),
            "{name}: a root with another start time was signalled"
        );
        assert_eq!(process::start_time(pid).unwrap(), start);
        assert!(
            cap.has(tracing::Level::WARN, "unit.root.not_pinned"),
            "{name}"
        );

        let legacy = c.adopt_legacy(
            LEGACY_CODEX_TAG_ENV,
            UnitId::mint().as_str(),
            &[(pid, start + 1)],
            label(),
        );
        legacy
            .stop(StopRequest::new(
                StopMode::Force,
                StopReason::BootFinish,
                "boot",
            ))
            .wait()
            .await;
        legacy.stop_in_flight().unwrap().wait_swept().await;
        assert!(
            alive(pid),
            "{name}: adopt_legacy signalled a mismatched root"
        );
        assert_eq!(process::start_time(pid).unwrap(), start);

        let unit = c.reopen_unit(&record(vec![(pid, start)]), label()).unwrap();
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::BootFinish,
            "boot",
        ))
        .wait()
        .await;
        use std::os::unix::process::ExitStatusExt;
        let status = sleep.wait();
        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "{name}: the matching root is stopped"
        );
    }
}

/// A legacy (v1) Codex sidecar adopted by `adopt_legacy` is found the same
/// way after the next restart: the reopened unit's members still include
/// every process carrying the legacy tag, not only its pinned roots, so a
/// later stop (or a boot finish) reaches what the old app-server started.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reopened_legacy_unit_still_finds_its_members_by_the_legacy_tag() {
    let root = StateRoot::new();
    for (name, c) in backends_with_state(root.path()) {
        let tag_value = format!("codex-sidecar-{}", UnitId::mint().as_str());
        // A pinned root, and a job that left its tree: a member only
        // through the legacy tag it carries.
        let launcher = OwnChild::sleep();
        let launcher_start = process::start_time(launcher.id()).unwrap();
        let job = OwnChild::spawn(
            std::process::Command::new("sleep")
                .arg("600")
                .env(LEGACY_CODEX_TAG_ENV, &tag_value),
        );
        let pids = |unit: &AgentUnit| -> Vec<u32> {
            unit.members().unwrap().iter().map(|m| m.pid).collect()
        };
        let adopted = c.adopt_legacy(
            LEGACY_CODEX_TAG_ENV,
            &tag_value,
            &[(launcher.id(), launcher_start)],
            label(),
        );
        assert!(
            pids(&adopted).contains(&job.id()),
            "{name}: the adoption finds the tagged job"
        );
        let unit_id = adopted.id().clone();

        // The restart: the unit and its containment go away without a stop.
        drop(adopted);
        drop(c);
        let c = rebuild(name, root.path());
        let records = c.recorded_units().unwrap();
        let record = records
            .iter()
            .find(|r| r.unit_id == unit_id)
            .expect("the adopted unit's record");
        let unit = c.reopen_unit(record, label()).unwrap();
        let members = pids(&unit);
        assert!(
            members.contains(&launcher.id()),
            "{name}: the pinned root is a member: {members:?}"
        );
        assert!(
            members.contains(&job.id()),
            "{name}: the tagged job is still a member: {members:?}"
        );

        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::BootFinish,
            "boot",
        ))
        .wait()
        .await;
        unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(!alive(launcher.id()), "{name}: the root is stopped");
        assert!(!alive(job.id()), "{name}: the tagged job is stopped");
        assert!(c.recorded_units().unwrap().is_empty(), "{name}");
    }
}

/// A legacy unit finds its members by its tag, its roots and their
/// descendants, never through a kernel container, whatever backend the
/// server selected. So its stop pins every member before the soft signal, as
/// the tag backend's units do: a child that carries no tag (an MCP server
/// Codex starts with an environment allow-list), a member only as the main's
/// child, is still killed after the main exits on SIGINT during the grace
/// and the child is reparented away from every root. Checked for the
/// adoption's own stop and for the stop of the unit reopened after a
/// restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_legacy_unit_pins_its_members_before_the_soft_signal() {
    let root = StateRoot::new();
    for (name, mut c) in backends_with_state(root.path()) {
        for reopened in [false, true] {
            let case = if reopened { "reopened" } else { "adopted" };
            let tag_value = format!("codex-sidecar-{}", UnitId::mint().as_str());
            let s = agent_script(&AgentOpts {
                untagged_child: true,
                exit_on_int: true,
                ..Default::default()
            });
            let (mut child, main) = spawn_tagged_main(&s, LEGACY_CODEX_TAG_ENV, &tag_value).await;
            let p = read_pids(&s).await;
            let mut unit = c.adopt_legacy(
                LEGACY_CODEX_TAG_ENV,
                &tag_value,
                &[(main.pid(), main.identity().start)],
                label(),
            );
            if reopened {
                // The restart: the unit and its containment go away without
                // a stop.
                let unit_id = unit.id().clone();
                drop(unit);
                drop(c);
                c = rebuild(name, root.path());
                let record = c
                    .recorded_units()
                    .unwrap()
                    .into_iter()
                    .find(|r| r.unit_id == unit_id)
                    .expect("the adopted unit's record");
                unit = c.reopen_unit(&record, label()).unwrap();
            }
            unit.set_main(main.clone());
            assert!(
                !unit.capability().full,
                "{name}/{case}: a legacy unit is not kernel-tracked: {:?}",
                unit.capability()
            );
            assert_eq!(
                process::environ_read(p.untagged, LEGACY_CODEX_TAG_ENV),
                process::EnvRead::Absent,
                "{name}/{case}: the child carries no tag"
            );
            assert_eq!(process::parent(p.untagged), Some(main.pid()));
            let members: Vec<u32> = unit.members().unwrap().iter().map(|m| m.pid).collect();
            assert!(
                members.contains(&p.untagged),
                "{name}/{case}: the untagged child is a member as the main's child: {members:?}"
            );

            unit.stop(StopRequest::new(
                StopMode::Force,
                StopReason::ShiftX,
                "test",
            ))
            .wait()
            .await;
            unit.stop_in_flight().unwrap().wait_swept().await;
            let status = child.wait().await.unwrap();
            assert_eq!(
                status.code(),
                Some(0),
                "{name}/{case}: the main exited on SIGINT during the grace"
            );
            for (what, pid) in [("setsid", p.setsid), ("pgrp", p.pgrp), ("nohup", p.nohup)] {
                assert!(
                    !alive(pid),
                    "{name}/{case}: the tagged {what} member survived"
                );
            }
            eventually(
                Duration::from_secs(5),
                &format!("{name}/{case}: the untagged child {} is killed", p.untagged),
                || !alive(p.untagged),
            )
            .await;
            assert!(c.recorded_units().unwrap().is_empty(), "{name}/{case}");
        }
    }
}

/// A child of the test, forked without exec, that only waits in pause(2):
/// pinned while it is the test's own unreaped child, killed through that pin
/// and reaped when dropped.
struct ForkedPause {
    pid: libc::pid_t,
    watch: ProcWatch,
}

impl ForkedPause {
    fn start() -> Self {
        // SAFETY: the child only calls pause(2) (async-signal-safe) until
        // the test kills it; it never returns into the test.
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            loop {
                unsafe { libc::pause() };
            }
        }
        assert!(pid > 0, "fork failed");
        match ProcWatch::open(pid as u32) {
            Ok(watch) => Self { pid, watch },
            Err(err) => {
                // SAFETY: our own unreaped child, so its pid still names it.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                    libc::waitpid(pid, std::ptr::null_mut(), 0);
                }
                panic!("cannot pin the forked child: {err}");
            }
        }
    }
}

impl Drop for ForkedPause {
    fn drop(&mut self) {
        let _ = self.watch.signal(Sig::Kill);
        // SAFETY: reaping our own child.
        unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
    }
}

/// A child another thread forked and that has not exec'd yet holds a copy of
/// every open descriptor, record locks included. Dropping a containment (the
/// in-process stand-in for a crashed server) must still free its records.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_containment_frees_its_records_even_while_a_forked_child_holds_their_descriptors()
{
    let root = StateRoot::new();
    for (name, a) in backends_with_state(root.path()) {
        let unit = a.create_unit(UnitId::mint(), label()).unwrap();
        let record = read_record(&record_path(root.path(), name, &unit));
        let forked = ForkedPause::start();
        drop(unit);
        drop(a);
        let c = rebuild(name, root.path());
        let found = c.recorded_units().unwrap();
        drop(forked);
        assert_eq!(found, vec![record], "{name}");
    }
}
