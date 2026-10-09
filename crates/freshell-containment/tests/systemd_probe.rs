#![cfg(target_os = "linux")]
//! The systemd probe against a stalled user manager: both the manager's
//! private socket (`$XDG_RUNTIME_DIR/systemd/private`, the only one systemd
//! 256+ uses) and the session bus (systemd 255 falls back to it) accept
//! connections and never answer, the stall measured at 90 s per command.
//! Its own test binary: it points this process's XDG_RUNTIME_DIR and
//! DBUS_SESSION_BUS_ADDRESS at them. Every process this stalls is one the
//! probe starts and kills itself at its deadline.

use std::os::unix::net::UnixListener;
use std::path::Path;
use std::time::{Duration, Instant};

use freshell_containment::*;

fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(tool).is_file()))
}

#[test]
fn a_stalled_user_bus_demotes_to_the_tag_backend_within_the_probe_deadline() {
    let runtime = tempfile::tempdir().unwrap();
    let bus = runtime.path().join("bus");
    std::fs::create_dir(runtime.path().join("systemd")).unwrap();
    for socket in [bus.clone(), runtime.path().join("systemd").join("private")] {
        let listener = UnixListener::bind(&socket).unwrap();
        // Accept every connection and hold it open without ever answering.
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for conn in listener.incoming().flatten() {
                held.push(conn);
            }
        });
    }
    std::env::set_var("XDG_RUNTIME_DIR", runtime.path());
    std::env::set_var(
        "DBUS_SESSION_BUS_ADDRESS",
        format!("unix:path={}", bus.display()),
    );

    let t0 = Instant::now();
    let c = Containment::select(SelectOptions::default());
    let took = t0.elapsed();

    let cap = c.capability();
    assert_eq!(cap.kind, BackendKind::LinuxTag, "{cap:?}");
    let reason = cap.reason.unwrap_or_default();
    // The probe's steps in order: cgroup v2, the tools, then the bus.
    if !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file() {
        assert!(reason.contains("cgroup v2"), "{reason}");
    } else if let Some(tool) = ["systemd-run", "systemctl"]
        .into_iter()
        .find(|t| !on_path(t))
    {
        assert!(reason.contains(tool), "the reason names {tool}: {reason}");
    } else {
        assert!(reason.contains("timed out"), "{reason}");
    }
    assert!(
        took < Duration::from_secs(25),
        "the probe took {took:?} (two 10 s attempts at most)"
    );
}
