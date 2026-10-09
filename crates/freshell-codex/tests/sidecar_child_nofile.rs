//! The Codex sidecar starts with the open-file soft limit its server recorded
//! before raising its own (`freshell_platform::child_nofile`).
//!
//! Node raises its own soft limit to the hard limit as it starts, so reading
//! the fake app-server's `/proc/<pid>/limits` would prove nothing. The sidecar
//! command is therefore a small `sh` script that writes the soft limit it was
//! started with, then execs the committed fake app-server.
//!
//! This is its own test binary because it changes this process's soft
//! `RLIMIT_NOFILE` and records the process-wide original, which is set once.
//! The only process stopped here is the sidecar this test spawned.
#![cfg(all(feature = "real-transport", target_os = "linux"))]

use std::path::PathBuf;
use std::time::Duration;

use freshell_codex::launch_lifecycle::{CodexLaunchRuntime, SpawnedCodexAppServerRuntime};
use freshell_platform::child_nofile;

const ORIGINAL_SOFT: u64 = 512;

fn own_limits() -> (u64, u64) {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    (lim.rlim_cur, lim.rlim_max)
}

fn set_own_soft(soft: u64) {
    let lim = libc::rlimit {
        rlim_cur: soft,
        rlim_max: own_limits().1,
    };
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);
}

#[tokio::test]
async fn the_codex_sidecar_starts_with_the_recorded_soft_limit() {
    // The server's start-up sequence: started at ORIGINAL_SOFT, recorded it,
    // raised its own soft limit to the hard limit.
    let hard = own_limits().1;
    assert!(
        hard > ORIGINAL_SOFT,
        "the test needs a hard limit above {ORIGINAL_SOFT} (got {hard})"
    );
    set_own_soft(ORIGINAL_SOFT);
    child_nofile::record_original_soft_limit(ORIGINAL_SOFT);
    set_own_soft(hard);
    assert_eq!(own_limits(), (hard, hard));

    let dir = tempfile::tempdir().expect("temp dir");
    let soft_file = dir.path().join("soft");
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    let script = dir.path().join("recording-codex.sh");
    std::fs::write(
        &script,
        format!(
            "ulimit -Sn > '{}'\nexec node '{}' \"$@\"\n",
            soft_file.display(),
            fixture.display()
        ),
    )
    .expect("write the recording launcher");

    let runtime = SpawnedCodexAppServerRuntime::with_command(format!("sh {}", script.display()));
    let ready = tokio::time::timeout(Duration::from_secs(30), runtime.ensure_ready(None))
        .await
        .expect("the sidecar must come up in time");
    let recorded = std::fs::read_to_string(&soft_file);
    runtime.shutdown().await.expect("stop the sidecar");

    ready.expect("the sidecar must come up");
    let recorded = recorded.expect("the launcher must record its soft limit");
    assert_eq!(recorded.trim(), ORIGINAL_SOFT.to_string());
}
