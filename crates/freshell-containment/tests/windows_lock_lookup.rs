#![cfg(windows)]
//! Own test binary: it holds every Restart Manager session the system allows
//! for a moment, which would fail any other lock lookup running beside it.
mod windows_support;

use std::path::PathBuf;

use freshell_containment::lock_holders;
use windows_support::captured;
use windows_sys::Win32::Foundation::{ERROR_MAX_SESSIONS_REACHED, ERROR_SUCCESS};
use windows_sys::Win32::System::RestartManager::{
    RmEndSession, RmStartSession, CCH_RM_SESSION_KEY,
};

/// Every Restart Manager session the system still had free, ended on drop.
/// The system allows 64 at a time.
struct AllSessions(Vec<u32>);

impl AllSessions {
    fn take() -> Self {
        let mut sessions = AllSessions(Vec::new());
        for _ in 0..1024 {
            let mut handle = 0u32;
            let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
            // SAFETY: valid out-pointers; the key buffer has room for the key.
            match unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) } {
                ERROR_SUCCESS => sessions.0.push(handle),
                ERROR_MAX_SESSIONS_REACHED => return sessions,
                other => panic!("RmStartSession: unexpected error {other}"),
            }
        }
        panic!(
            "the Restart Manager never refused a session (held {})",
            sessions.0.len()
        );
    }
}

impl Drop for AllSessions {
    fn drop(&mut self) {
        for handle in self.0.drain(..) {
            // SAFETY: a session this test started, ended once.
            unsafe { RmEndSession(handle) };
        }
    }
}

/// A Restart Manager call that fails makes the lookup answer "no holder"
/// without having asked, so it is logged as a warning naming the failing
/// call and its error; a lookup that works logs nothing.
#[test]
fn a_restart_manager_failure_is_logged_with_the_failing_call() {
    let captured = captured();
    let failures = || {
        captured
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.event == "containment.lock_lookup_failed")
            .cloned()
            .collect::<Vec<_>>()
    };
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().join("t.lock");
    // This test process holds the file open, so a working lookup finds it.
    let _open = std::fs::File::create(&path).unwrap();

    let holders = lock_holders(std::slice::from_ref(&path));
    assert!(
        holders.iter().any(|h| h.pid == std::process::id()),
        "the working lookup missed this process: {holders:?}"
    );
    assert!(failures().is_empty(), "a working lookup logged a failure");

    let sessions = AllSessions::take();
    let holders = lock_holders(std::slice::from_ref(&path));
    drop(sessions);
    assert!(holders.is_empty(), "{holders:?}");
    let logged = failures();
    assert!(
        logged.iter().any(|e| e.level == tracing::Level::WARN
            && e.fields.get("call").map(String::as_str) == Some("RmStartSession")
            && e.fields.get("code").map(String::as_str)
                == Some(ERROR_MAX_SESSIONS_REACHED.to_string().as_str())
            && e.fields.get("path") == Some(&path.display().to_string())),
        "the failed session start was not logged: {logged:?}"
    );
}
