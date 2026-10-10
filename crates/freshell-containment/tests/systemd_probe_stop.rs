#![cfg(target_os = "linux")]
//! The systemd probe when its probe slice cannot be stopped. Fake
//! `systemd-run` and `systemctl` come first on PATH, so the probe places
//! nothing and stops nothing for real. Its own test binary: it sets this
//! process's PATH and XDG_RUNTIME_DIR.
mod support;

use std::path::Path;

use freshell_containment::*;
use support::*;

/// Writes an executable script without this multi-threaded process ever
/// holding a write descriptor to it: a child forked meanwhile would hold it
/// open, and running the script would then fail with ETXTBSY.
fn write_script(path: &Path, body: &str) {
    let status = std::process::Command::new("sh")
        .args([
            "-c",
            "printf '%s' \"$2\" > \"$1\" && chmod 755 \"$1\"",
            "sh",
        ])
        .arg(path)
        .arg(body)
        .status()
        .unwrap();
    assert!(status.success(), "{status:?}");
}

#[test]
fn a_probe_slice_that_cannot_be_stopped_is_logged_as_a_warning() {
    let bin = tempfile::tempdir().unwrap();
    // Places the probe somewhere else, so the probe fails after its stop.
    write_script(
        &bin.path().join("systemd-run"),
        "#!/bin/sh\n\
         if [ \"$1\" = --version ]; then echo 'systemd 255 (255.4-1ubuntu8.17)'; exit 0; fi\n\
         echo '0::/elsewhere.scope'\n",
    );
    write_script(
        &bin.path().join("systemctl"),
        "#!/bin/sh\n\
         case \"$2\" in\n\
         show) echo /user.slice/user-1000.slice/user@1000.service ;;\n\
         stop) echo \"Failed to stop $3: Access denied\" >&2; exit 1 ;;\n\
         esac\n",
    );
    let runtime = tempfile::tempdir().unwrap();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path = std::iter::once(bin.path().to_path_buf()).chain(std::env::split_paths(&path));
    std::env::set_var("PATH", std::env::join_paths(path).unwrap());
    std::env::set_var("XDG_RUNTIME_DIR", runtime.path());

    let (cap, _guard) = capture::install();
    let c = Containment::select(SelectOptions::default());
    let selected = c.capability();
    assert_eq!(selected.kind, BackendKind::LinuxTag, "{selected:?}");
    let reason = selected.reason.unwrap_or_default();
    if !Path::new("/sys/fs/cgroup/cgroup.controllers").is_file() {
        // The probe's first step, before any slice exists.
        assert!(reason.contains("cgroup v2"), "{reason}");
        return;
    }
    assert!(reason.contains("not under"), "{reason}");
    let warnings: Vec<capture::Event> = cap
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.event == "containment.probe_slice_stop_failed")
        .cloned()
        .collect();
    assert_eq!(warnings.len(), 2, "one per probe attempt: {warnings:?}");
    for warning in &warnings {
        assert_eq!(warning.level, tracing::Level::WARN);
        let slice = &warning.fields["slice"];
        // Outside every server's namespace (`freshell-n<ns>`).
        assert!(
            slice.starts_with("freshell-probe") && slice.ends_with(".slice"),
            "{slice}"
        );
        assert!(
            warning.fields["error"].contains("Access denied"),
            "{warning:?}"
        );
    }
}
