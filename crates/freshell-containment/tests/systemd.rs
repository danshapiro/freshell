#![cfg(target_os = "linux")]
//! systemd backend specifics. On hosts with a user manager (garageserver)
//! FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 makes the
//! selection itself a hard requirement; elsewhere these tests assert the
//! degraded selection instead, so they never silently pass on nothing.
//! Every process signalled here was started by the test (through the unit
//! under test), and every slice stopped here holds only the test's own units.
//! Runtimes get two workers each (the Docker sandbox's 512-task cap).
mod support;

use std::path::Path;
use std::time::Duration;

use freshell_containment::*;
use support::*;

fn require() -> bool {
    std::env::var("FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT").as_deref() == Ok("1")
}

fn label() -> UnitLabel {
    UnitLabel {
        provider: "test".into(),
        ..Default::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selection_matches_the_host() {
    let c = Containment::select(SelectOptions::default());
    if require() {
        assert_eq!(c.capability().kind, BackendKind::SystemdScope);
        assert!(c.capability().full);
    } else if c.capability().kind != BackendKind::SystemdScope {
        assert_eq!(c.capability().kind, BackendKind::LinuxTag);
        assert!(
            c.capability().reason.is_some(),
            "a degraded selection names why"
        );
    }
}

fn systemd_or_skip_reason() -> Option<Containment> {
    let c = Containment::select(SelectOptions::default());
    (c.capability().kind == BackendKind::SystemdScope).then_some(c)
}

/// The systemd backend with its unit records under `root`.
fn systemd_on(root: &Path) -> Option<Containment> {
    let c = Containment::select(SelectOptions {
        state_root: root.to_path_buf(),
        ..Default::default()
    });
    (c.capability().kind == BackendKind::SystemdScope).then_some(c)
}

/// `<ns>` of the unit slice in `cgroup` (`…/freshell.slice/freshell-n<ns>.slice/…`).
fn namespace_in(cgroup: &str) -> String {
    let after = cgroup
        .split_once("/freshell.slice/freshell-n")
        .unwrap_or_else(|| panic!("not under freshell.slice: {cgroup}"))
        .1;
    after
        .split_once(".slice/")
        .unwrap_or_else(|| panic!("no namespace slice: {cgroup}"))
        .0
        .to_string()
}

fn is_lower_hex(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn stop_force(unit: &AgentUnit, reason: StopReason) -> StopHandle {
    unit.stop(StopRequest::new(StopMode::Force, reason, "test"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn members_land_in_the_unit_slice_with_their_pid_preserved_outside_our_cgroup() {
    let Some(c) = systemd_or_skip_reason() else {
        assert!(!require(), "systemd containment required on this host");
        return;
    };
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let s = agent_script(&AgentOpts::default());
    let child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    assert_eq!(
        child.id(),
        Some(p.main),
        "systemd-run placed itself and exec'd the agent in place"
    );

    let id = unit.id().as_str();
    let cgroup = cgroup_path_of(p.main);
    let ns = namespace_in(&cgroup);
    assert!(ns.len() == 16 && is_lower_hex(&ns), "namespace {ns:?}");
    assert_eq!(
        ns,
        systemd_namespace(Path::new("")),
        "the namespace is the hash of the state root"
    );
    let slice = format!("/freshell.slice/freshell-n{ns}.slice/freshell-n{ns}-{id}.slice/");
    let at = cgroup
        .find(&slice)
        .unwrap_or_else(|| panic!("{cgroup} is not in {slice}"));
    assert!(
        cgroup[at + slice.len()..].starts_with(&format!("freshell-n{ns}-{id}-agent-")),
        "the agent runs in its own agent scope: {cgroup}"
    );
    let own = cgroup_path_of(std::process::id());
    assert!(
        cgroup != own && !cgroup.starts_with(&format!("{own}/")),
        "{cgroup} lies inside the test's own cgroup {own}"
    );

    // A second unit of the same containment shares the namespace.
    let other = c.create_unit(UnitId::mint(), label()).unwrap();
    let s2 = agent_script(&AgentOpts::default());
    let _other_child = spawn_main(&other, &s2).await;
    let p2 = read_pids(&s2).await;
    let other_cgroup = cgroup_path_of(p2.main);
    assert_eq!(namespace_in(&other_cgroup), ns);
    assert!(
        other_cgroup.contains(&format!("/freshell-n{ns}-{}.slice/", other.id().as_str())),
        "{other_cgroup}"
    );
    stop_force(&other, StopReason::ShiftX).wait_swept().await;

    // One-shot placement confirmation.
    unit.confirm_placement(p.main).unwrap();
    let mut stranger = OwnChild::sleep(); // spawned without placement
    let refused = unit.confirm_placement(stranger.id()).unwrap_err();
    assert_ne!(refused.kind(), std::io::ErrorKind::NotFound, "{refused}");
    let stranger_cgroup = cgroup_path_of(stranger.id());
    assert!(
        refused.to_string().contains(&stranger_cgroup),
        "the refusal names where the process actually is: {refused}"
    );
    stranger.kill_and_wait();

    // Arguments reach the agent literally.
    let out = tempfile::tempdir().unwrap();
    let file = out.path().join("arg");
    let mut cmd = unit
        .tokio_command(
            "sh",
            &[
                "-c".into(),
                format!("printf %s \"$1\" > '{}'", file.display()),
                "sh".into(),
                "$HOME".into(),
            ],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.stdin(std::process::Stdio::null());
    let status = cmd.status().await.unwrap();
    assert!(status.success(), "{status:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "$HOME");

    let handle = stop_force(&unit, StopReason::ShiftX);
    handle.wait().await;
    assert!(handle.wait_swept().await.is_empty());
    assert!(!alive(p.main));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_unit_outlives_its_server_and_is_finished_after_reopen() {
    let root = StateRoot::new();
    let Some(a) = systemd_on(root.path()) else {
        assert!(!require(), "systemd containment required on this host");
        return;
    };
    let unit = a.create_unit(UnitId::mint(), label()).unwrap();
    let s = agent_script(&AgentOpts::default());
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    let main_start = process::start_time(p.main).unwrap();
    let (_, slice_dir) = unit_slice_of(p.main).expect("the main runs in its unit slice");
    let record_file = root
        .path()
        .join("units")
        .join(format!("{}.json", unit.id().as_str()));

    // Server A goes away without a stop, as in a restart.
    drop(unit);
    drop(a);

    let b = systemd_on(root.path()).expect("the same host selects the same backend");
    let records = b.recorded_units().unwrap();
    assert_eq!(records.len(), 1, "{records:?}");
    let record = &records[0];
    assert_eq!(record.state, UnitRecordState::Running);
    assert!(
        record.roots.contains(&(p.main, main_start)),
        "{:?}",
        record.roots
    );
    let unit = b.reopen_unit(record, label()).unwrap();
    let members: Vec<u32> = unit.members().unwrap().iter().map(|m| m.pid).collect();
    for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
        assert!(members.contains(&pid), "{pid} is not a member: {members:?}");
    }

    let handle = stop_force(&unit, StopReason::BootFinish);
    handle.wait().await;
    let survivors = handle.wait_swept().await;
    assert!(survivors.is_empty(), "{survivors:?}");
    for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
        assert!(!alive(pid), "{pid} survived the boot finish");
    }
    assert!(!record_file.exists(), "Gone deletes the record");
    assert!(
        !slice_dir.exists(),
        "the sweep stopped the emptied slice: {}",
        slice_dir.display()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_screen_in_a_reopened_unit_never_collides_with_a_pre_restart_scope() {
    let root = StateRoot::new();
    let Some(a) = systemd_on(root.path()) else {
        assert!(!require(), "systemd containment required on this host");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let job_pid = dir.path().join("job.pid");
    let marker = dir.path().join("marker");

    // A's screen starts a detached job (it keeps A's screen scope populated)
    // and exits.
    let unit = a.create_unit(UnitId::mint(), label()).unwrap();
    let mut screen = unit
        .tokio_command(
            "sh",
            &[
                "-c".into(),
                format!(
                    "setsid sleep 600 >/dev/null 2>&1 & echo $! > '{0}.tmp' && mv '{0}.tmp' '{0}'",
                    job_pid.display()
                ),
            ],
            MemberRole::Screen,
        )
        .unwrap();
    screen.stdin(std::process::Stdio::null());
    assert!(screen.status().await.unwrap().success());
    let job: u32 = std::fs::read_to_string(&job_pid)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let job = ProcWatch::open(job).unwrap();
    let job_start = job.identity().start;
    let _cleanup = StopSliceOnDrop::holding(job.pid());
    assert!(
        unit_slice_of(job.pid()).is_some(),
        "the job is in the unit slice"
    );
    let record = only_record(&a, &unit);
    drop(unit);
    drop(a);

    // B (a new boot nonce) reopens the unit and starts a new screen.
    let b = systemd_on(root.path()).expect("the same host selects the same backend");
    assert_eq!(b.recorded_units().unwrap(), vec![record.clone()]);
    let unit = b.reopen_unit(&record, label()).unwrap();
    let mut screen = unit
        .tokio_command(
            "sh",
            &["-c".into(), format!("touch '{}'", marker.display())],
            MemberRole::Screen,
        )
        .unwrap();
    screen.stdin(std::process::Stdio::null());
    let status = screen.status().await.unwrap();
    assert!(
        status.success() && marker.exists(),
        "the new screen's scope collided with A's: {status:?}"
    );

    let handle = stop_force(&unit, StopReason::ShiftX);
    handle.wait().await;
    handle.wait_swept().await;
    assert!(
        job.has_exited(),
        "the pre-restart detached job survived the stop"
    );
    assert!(ProcWatch::open_expecting(job.pid(), job_start).is_err());
}

/// The record `a` holds for `unit` (its only one).
fn only_record(a: &Containment, unit: &AgentUnit) -> UnitRecord {
    let records = a.recorded_units().unwrap();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(&records[0].unit_id, unit.id());
    records[0].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_root_killed_before_placement_places_nothing() {
    let Some(c) = systemd_or_skip_reason() else {
        assert!(!require(), "systemd containment required on this host");
        return;
    };
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let id = unit.id().as_str().to_string();
    // A slice systemd creates for a placement already under way is stopped
    // at the end (a leftover implicit slice is never collected).
    let _cleanup = StopSliceOnDrop::named(format!(
        "freshell-n{}-{id}.slice",
        systemd_namespace(Path::new(""))
    ));
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("marker");
    let mut cmd = unit
        .tokio_command(
            "sh",
            &[
                "-c".into(),
                format!("touch '{}'; exec sleep 600", marker.display()),
            ],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(false);
    let mut child = cmd.spawn().unwrap();
    // Our own unreaped child: its pid names it.
    let root = ProcWatch::open(child.id().unwrap()).unwrap();
    unit.add_root(root.clone());
    let handle = stop_force(&unit, StopReason::ShiftX);
    handle.wait().await;
    handle.wait_swept().await;
    assert!(root.has_exited(), "the root survived");
    assert!(
        !marker.exists(),
        "the command ran: placement finished first"
    );

    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!marker.exists(), "the command ran after the stop");
    let tagged: Vec<u32> = process::all_pids()
        .into_iter()
        .filter(|pid| process::environ_value(*pid, UNIT_ENV).as_deref() == Some(id.as_str()))
        .collect();
    assert!(
        tagged.is_empty(),
        "processes carry the unit tag: {tagged:?}"
    );
    assert!(unit.members().unwrap().is_empty());
    child.wait().await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn the_codex_daemon_family_is_spared_in_place_and_its_slice_left_running() {
    let (cap, _guard) = capture::install();
    let Some(c) = systemd_or_skip_reason() else {
        assert!(!require(), "systemd containment required on this host");
        return;
    };
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let s = agent_script(&AgentOpts {
        daemon_family: true,
        managed_daemon_child: true,
        ..Default::default()
    });
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    let (slice, slice_dir) = unit_slice_of(p.daemon).expect("the daemon stand-in is in the slice");
    let _cleanup = StopSliceOnDrop::named(slice);
    let family: Vec<(u32, u64, String)> = [p.daemon, p.updater, p.installer, p.legacy]
        .into_iter()
        .map(|pid| {
            assert!(alive(pid), "stand-in {pid} started");
            (pid, process::start_time(pid).unwrap(), cgroup_path_of(pid))
        })
        .collect();

    let handle = stop_force(&unit, StopReason::ShiftX);
    handle.wait().await;
    handle.wait_swept().await;
    for (pid, start, cgroup) in &family {
        assert!(alive(*pid), "daemon-family stand-in {pid} was killed");
        assert_eq!(process::start_time(*pid).unwrap(), *start);
        assert_eq!(&cgroup_path_of(*pid), cgroup, "stand-in {pid} was moved");
    }
    for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
        assert!(!alive(pid), "{pid} survived");
    }
    assert!(
        slice_dir.is_dir(),
        "the slice the spared daemon still runs in was stopped"
    );
    assert!(cap.has(tracing::Level::INFO, "unit.stop.spared"));
    for (pid, start, _) in family {
        if let Ok(watch) = ProcWatch::open_expecting(pid, start) {
            watch.signal(Sig::Kill).unwrap();
        }
    }
}
