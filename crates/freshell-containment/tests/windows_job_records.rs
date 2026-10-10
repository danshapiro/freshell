#![cfg(windows)]
//! Own test binary: it sets the process-wide test-hook environment (Gone is
//! held after the exits are confirmed, so the record can be read mid-stop).
mod windows_support;

use std::process::Stdio;
use std::time::Duration;

use freshell_containment::{
    process, Containment, MemberRole, ProcWatch, SelectOptions, StopMode, StopReason, StopRequest,
    UnitId, UnitLabel, UnitRecord, UnitRecordState,
};
use windows_support::{child_named, test_shim, AsyncLines, Proc, EXIT_WAIT, HELPER};

/// A stop that spares a daemon-family member clears kill-on-close, so a
/// server that crashed before Gone would leave the other members running:
/// before ending them, the backend records each one in the unit record as
/// a root (here the plain member's shim, which nothing else pins), and never
/// a spared one, so the next boot reaches them by identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_that_spares_members_records_the_others_as_roots_before_ending_them() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", "3000");
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
    let (family_shim, family) = (&started[0].1, &started[0].2);
    let (plain_shim, plain) = (&started[1].1, &started[1].2);
    assert_eq!(
        child_named(plain_shim.pid, "freshell-test-helper.exe"),
        Some(plain.pid)
    );
    let plain_shim_start = process::start_time(plain_shim.pid).unwrap();
    unit.set_main(ProcWatch::open(plain.pid).unwrap());

    let handle = unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ));
    assert!(plain.wait(EXIT_WAIT), "the plain member outlived the kill");
    // Gone is held for 3 s after the exits are confirmed: the record is
    // still there, Stopping.
    let record: UnitRecord = serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    assert!(
        matches!(record.state, UnitRecordState::Stopping { .. }),
        "{record:?}"
    );
    assert!(
        record.roots.contains(&(plain_shim.pid, plain_shim_start)),
        "the plain member's shim is not recorded: {record:?}"
    );
    for spared in [family_shim.pid, family.pid] {
        assert!(
            record.roots.iter().all(|(pid, _)| *pid != spared),
            "the spared {spared} is recorded: {record:?}"
        );
    }
    handle
        .wait_for(Duration::from_secs(30))
        .await
        .expect("Gone within 30 s");
    assert!(!record_path.exists(), "the record is deleted at Gone");
    assert!(family.running(), "the spared member was killed");
    // The spared shim and member are terminated through their handles.
}
