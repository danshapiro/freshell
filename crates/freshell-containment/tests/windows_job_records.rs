#![cfg(windows)]
//! Own test binary: it sets the process-wide test-hook environment (Gone is
//! held after the exits are confirmed, so the record can be read mid-stop).
mod windows_support;

use std::process::Stdio;
use std::time::{Duration, Instant};

use freshell_containment::{
    process, Containment, MemberRole, ProcWatch, SelectOptions, StopMode, StopReason, StopRequest,
    UnitId, UnitLabel, UnitRecord, UnitRecordState,
};
use windows_support::{test_shim, wide, AsyncLines, Lines, Proc, EXIT_WAIT, HELPER};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, OpenJobObjectW};
use windows_sys::Win32::System::SystemServices::JOB_OBJECT_ASSIGN_PROCESS;

/// The record on disk, once `ok` holds for it (bounded retry: the port
/// thread records asynchronously, and a read can meet the atomic rename).
fn record_once(path: &std::path::Path, what: &str, ok: impl Fn(&UnitRecord) -> bool) -> UnitRecord {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<UnitRecord>(&bytes).ok());
        if let Some(record) = &read {
            if ok(record) {
                return record.clone();
            }
        }
        assert!(Instant::now() < deadline, "{what}: {read:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Once a stop that spares a daemon-family member has cleared
/// kill-on-close, the unit's members would outlive a crashed server, so
/// every process that joins the unit's job from then on is recorded in the
/// unit record as a root (the next boot reaches it by identity), and its
/// root is dropped again when it exits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_joining_after_kill_on_close_is_cleared_is_recorded_until_it_exits() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", "15000");
    let state = tempfile::tempdir().unwrap();
    let containment = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = containment
        .create_unit(
            UnitId::mint(),
            UnitLabel {
                provider: "codex".into(),
                mode: "codex".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let record_path = state
        .path()
        .join("units")
        .join(format!("{}.json", unit.id().as_str()));
    let mut started = Vec::new();
    for args in [
        &["idle", "app-server", "--managed-daemon"][..],
        &["idle"][..],
    ] {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let mut command = unit
            .tokio_command(HELPER, &args, MemberRole::Agent)
            .unwrap();
        command.stdin(Stdio::null()).stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let shim = Proc::open(child.id().unwrap());
        let mut lines = AsyncLines::new(child.stdout.take().unwrap());
        let helper = Proc::open(lines.expect_pid("idle ").await);
        started.push((child, shim, helper));
    }
    let family = &started[0].2;
    let plain = &started[1].2;
    unit.set_main(ProcWatch::open(plain.pid).unwrap());

    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    assert!(plain.wait(EXIT_WAIT), "the plain member outlived the kill");
    // Gone is held: kill-on-close is cleared (a member was spared) and the
    // record is still there, Stopping.
    record_once(&record_path, "a Stopping record", |r| {
        matches!(r.state, UnitRecordState::Stopping { .. })
    });

    // A process joins the unit's job now.
    let mut late = std::process::Command::new(HELPER)
        .arg("idle")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let late_proc = Proc::open(late.id());
    Lines::new(late.stdout.take().unwrap()).expect_pid("idle ");
    let late_start = process::start_time(late_proc.pid).unwrap();
    let name = wide(&format!("Local\\freshell-unit-{}", unit.id().as_str()));
    // SAFETY: a NUL-terminated name; the handle is checked and closed.
    unsafe {
        let job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, 0, name.as_ptr());
        assert!(
            !job.is_null(),
            "open the unit's job: {}",
            std::io::Error::last_os_error()
        );
        let joined = AssignProcessToJobObject(job, late_proc.handle);
        let err = std::io::Error::last_os_error();
        CloseHandle(job);
        assert_ne!(joined, 0, "assign to the unit's job: {err}");
    }
    record_once(
        &record_path,
        "the joining process recorded as a root",
        |r| r.roots.contains(&(late_proc.pid, late_start)),
    );
    late_proc.terminate();
    assert!(late_proc.wait(EXIT_WAIT));
    record_once(&record_path, "the exited process's root dropped", |r| {
        r.roots.iter().all(|(pid, _)| *pid != late_proc.pid)
    });
    let _ = late.wait();

    handle
        .wait_for(Duration::from_secs(30))
        .await
        .expect("Gone within 30 s");
    assert!(!record_path.exists(), "the record is deleted at Gone");
    assert!(family.running(), "the spared member was killed");
    // The spared shim and member are terminated through their handles.
}
